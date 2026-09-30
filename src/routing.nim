# src/routing.nim
# Declarative, Fail-Fast Laya System 1 Task Routing Engine for Locutus.
# Handles rhizo-routes.yaml parsing, question-level chunk aggregation,
# fail-fast timeout/connectivity, and schema linting.

import std/[os, strutils, json, tables, httpclient, uri, net]
import yaml/tojson

type
  OverflowStrategy* = enum
    osSplitAggregate = "split_aggregate"
    osLeadTail = "lead_tail"
    osFailFast = "fail_fast"

  ChoiceAggregate* = enum
    caMaxConfidence = "max_confidence"
    caMeanProb = "mean_prob"
    caMajorityVote = "majority_vote"

  ScoreAggregate* = enum
    saMax = "max"
    saMean = "mean"
    saSum = "sum"
    saMin = "min"

  NoulAggregate* = enum
    naAny = "any"
    naAll = "all"
    naMean = "mean"

  RoutingLimits* = object
    overflowStrategy*: OverflowStrategy
    chunkSize*: int             # default 8000 chars
    chunkOverlap*: int          # default 800 chars
    splitDelimiter*: string     # default "\n"
    maxChunks*: int             # default 10
    defaultChoiceAgg*: ChoiceAggregate
    defaultScoreAgg*: ScoreAggregate
    defaultNoulAgg*: NoulAggregate

  RoutingServiceConfig* = object
    url*: string                # default "http://127.0.0.1:8000"
    timeoutSeconds*: float      # default 5.0
    model*: string              # optional model identifier (e.g. "kev-4b", "decider-4b")
    apiKey*: string             # optional API key for hosted endpoints (e.g. TypeSafe Jev)

  QuestionConfig* = object
    id*: string
    qType*: string              # "choice", "score", "noul"
    instructions*: string
    options*: seq[string]       # for choice
    criteria*: seq[string]      # for score
    rawNode*: JsonNode          # underlying node for Laya
    choiceAgg*: ChoiceAggregate
    scoreAgg*: ScoreAggregate
    noulAgg*: NoulAggregate

  MatchCondition* = object
    key*: string                # e.g. "domain.choice", "urgency.score"
    operator*: string           # "eq", "in", "gte", "gt", "lte", "lt"
    strValue*: string
    seqValue*: seq[string]
    floatValue*: float

  RouteTarget* = object
    queue*: string              # e.g. "queue:swarm:{{ domain.choice }}" or "queue:worker:worker-claude"
    tags*: seq[string]          # e.g. ["database", "sql"]
    leaseSeconds*: int          # default 1800

  RouteRule* = object
    name*: string
    conditions*: seq[MatchCondition]
    target*: RouteTarget

  RoutingConfig* = object
    version*: string
    configPath*: string
    service*: RoutingServiceConfig
    limits*: RoutingLimits
    questions*: Table[string, QuestionConfig]
    routes*: seq[RouteRule]

  RoutingDecision* = object
    matchedRule*: string
    targetQueue*: string
    tags*: seq[string]
    leaseSeconds*: int
    rawAnswers*: JsonNode
    aggregationMetadata*: JsonNode

proc parseChoiceAgg(s: string, defaultVal: ChoiceAggregate = caMaxConfidence): ChoiceAggregate =
  case s.toLowerAscii
  of "max_confidence", "confidence", "max": caMaxConfidence
  of "mean_prob", "mean", "probability_mean": caMeanProb
  of "majority_vote", "majority", "vote": caMajorityVote
  else: defaultVal

proc parseScoreAgg(s: string, defaultVal: ScoreAggregate = saMax): ScoreAggregate =
  case s.toLowerAscii
  of "max": saMax
  of "mean", "avg": saMean
  of "sum": saSum
  of "min": saMin
  else: defaultVal

proc parseNoulAgg(s: string, defaultVal: NoulAggregate = naAny): NoulAggregate =
  case s.toLowerAscii
  of "any", "or": naAny
  of "all", "and": naAll
  of "mean", "avg": naMean
  else: defaultVal

proc parseOverflowStrategy(s: string): OverflowStrategy =
  case s.toLowerAscii
  of "split_aggregate", "chunk", "aggregate": osSplitAggregate
  of "lead_tail", "head_tail", "slice": osLeadTail
  of "fail_fast", "failfast", "error": osFailFast
  else: osSplitAggregate

proc defaultRoutingLimits*(): RoutingLimits =
  result.overflowStrategy = osSplitAggregate
  result.chunkSize = 8000
  result.chunkOverlap = 800
  result.splitDelimiter = "\n"
  result.maxChunks = 10
  result.defaultChoiceAgg = caMaxConfidence
  result.defaultScoreAgg = saMax
  result.defaultNoulAgg = naAny

proc defaultServiceConfig*(): RoutingServiceConfig =
  result.url = "http://127.0.0.1:8000"
  result.timeoutSeconds = 5.0
  result.model = ""
  result.apiKey = ""

# Find configuration file starting from startDir walking up
proc findRoutesConfig*(customPath: string = ""): string =
  if customPath.len > 0:
    if fileExists(customPath): return customPath
    raise newException(IOError, "Custom routes file not found: " & customPath)

  let envPath = getEnv("RHIZO_ROUTES_FILE", getEnv("LOCUTUS_ROUTES_FILE", getEnv("LOCU_ROUTES_FILE", "")))
  if envPath.len > 0 and fileExists(envPath): return envPath

  var cur = getCurrentDir()
  while true:
    for candidate in ["rhizo-routes.yaml", "rhizo-routes.yml", "rhizo-routes.json",
                      ".rhizo/routes.yaml", ".rhizo/routes.yml", ".rhizo/routes.json",
                      "locu-routes.yaml", "locu-routes.yml", "locu-routes.json",
                      ".locu/routes.yaml", ".locu/routes.yml", ".locu/routes.json",
                      "locutus-routes.yaml", "locutus-routes.yml", "locutus-routes.json",
                      ".locutus/routes.yaml", ".locutus/routes.yml", ".locutus/routes.json"]:
      let p = cur / candidate
      if fileExists(p): return p

    if dirExists(cur / ".git") or fileExists(cur / ".git"):
      break
    let parent = cur.parentDir()
    if parent == cur or parent.len == 0:
      break
    cur = parent
  return ""

# Lint YAML / JSON route configuration
proc lintYamlContent*(content: string, checkService: bool = false): tuple[valid: bool, errors: seq[string], warnings: seq[string]] =
  var errors: seq[string] = @[]
  var warnings: seq[string] = @[]

  var doc: seq[JsonNode]
  try:
    var s = content
    doc = loadToJson(s)
  except CatchableError as e:
    return (false, @["YAML syntax error: " & e.msg], @[])

  if doc.len == 0 or doc[0] == nil or doc[0].kind != JObject:
    return (false, @["Root document must be a YAML/JSON mapping object"], @[])

  let root = doc[0]

  # Version check
  if not root.hasKey("version"):
    warnings.add("Missing 'version' field in route configuration (recommended: version: \"1.0\")")

  # Questions check
  if not root.hasKey("questions") or root["questions"].kind != JObject or root["questions"].len == 0:
    errors.add("Missing or empty 'questions' section: at least one classifier question is required")

  var questionIds: seq[string] = @[]
  var questionOptions: Table[string, seq[string]] = initTable[string, seq[string]]()

  if root.hasKey("questions") and root["questions"].kind == JObject:
    for qid, qNode in root["questions"]:
      questionIds.add(qid)
      if qNode.kind != JObject:
        errors.add("Question '" & qid & "' must be a mapping object")
        continue

      let qType = qNode.getOrDefault("type").getStr("").toLowerAscii
      if qType notin ["choice", "score", "noul"]:
        errors.add("Question '" & qid & "' has invalid type '" & qType & "'. Must be choice, score, or noul")

      if qNode.getOrDefault("instructions").getStr("").strip().len == 0:
        errors.add("Question '" & qid & "' missing required 'instructions'")

      # Options validation for choice
      if qType == "choice":
        var opts: seq[string] = @[]
        if qNode.hasKey("options") and qNode["options"].kind == JArray:
          for o in qNode["options"]: opts.add(o.getStr())
        elif qNode.hasKey("criteria") and qNode["criteria"].kind == JObject:
          for k, _ in qNode["criteria"]: opts.add(k)
        elif qNode.hasKey("criteria") and qNode["criteria"].kind == JArray:
          for o in qNode["criteria"]: opts.add(o.getStr())
        
        if opts.len == 0:
          errors.add("Choice question '" & qid & "' must define non-empty 'options' list or 'criteria' mapping")
        questionOptions[qid] = opts

        # Aggregation validation for choice
        if qNode.hasKey("aggregate"):
          let aggStr = qNode["aggregate"].getStr("").toLowerAscii
          if aggStr notin ["max_confidence", "confidence", "mean_prob", "mean", "majority_vote", "vote"]:
            errors.add("Invalid aggregation strategy '" & aggStr & "' for choice question '" & qid &
                       "'. Valid options: max_confidence, mean_prob, majority_vote")

      elif qType == "score":
        var critCount = 0
        if qNode.hasKey("criteria") and qNode["criteria"].kind == JArray: critCount = qNode["criteria"].len
        elif qNode.hasKey("rubric") and qNode["rubric"].kind == JArray: critCount = qNode["rubric"].len
        elif qNode.hasKey("levels") and qNode["levels"].kind == JArray: critCount = qNode["levels"].len
        elif qNode.hasKey("criteria") and qNode["criteria"].kind == JObject: critCount = qNode["criteria"].len

        if critCount < 2:
          errors.add("Score question '" & qid & "' must define at least 2 levels in 'criteria' list")

        # Aggregation validation for score
        if qNode.hasKey("aggregate"):
          let aggStr = qNode["aggregate"].getStr("").toLowerAscii
          if aggStr notin ["max", "mean", "avg", "sum", "min"]:
            errors.add("Invalid aggregation strategy '" & aggStr & "' for score question '" & qid &
                       "'. Valid options: max, mean, sum, min")

      elif qType == "noul":
        if qNode.hasKey("aggregate"):
          let aggStr = qNode["aggregate"].getStr("").toLowerAscii
          if aggStr notin ["any", "or", "all", "and", "mean", "avg"]:
            errors.add("Invalid aggregation strategy '" & aggStr & "' for noul question '" & qid &
                       "'. Valid options: any, all, mean")

  # Routes check
  if not root.hasKey("routes") or root["routes"].kind != JArray or root["routes"].len == 0:
    errors.add("Missing or empty 'routes' section: at least one routing rule is required")

  var seenRuleNames: seq[string] = @[]

  if root.hasKey("routes") and root["routes"].kind == JArray:
    for idx, rNode in root["routes"].elems:
      if rNode.kind != JObject:
        errors.add("Route at index " & $idx & " must be an object")
        continue

      let name = rNode.getOrDefault("name").getStr("route-" & $idx)
      if name in seenRuleNames:
        warnings.add("Duplicate route rule name: '" & name & "'")
      seenRuleNames.add(name)

      # Match conditions
      if not rNode.hasKey("match") or rNode["match"].kind != JObject or rNode["match"].len == 0:
        errors.add("Route '" & name & "' missing non-empty 'match' conditions")
      else:
        for mKey, mVal in rNode["match"]:
          let qPrefix = mKey.split('.')[0]
          if qPrefix notin questionIds:
            errors.add("Route '" & name & "' references undeclared question '" & qPrefix & "' in match key '" & mKey & "'")
          else:
            # If matching a choice option, verify option exists
            if questionOptions.hasKey(qPrefix):
              let opts = questionOptions[qPrefix]
              if mVal.kind == JString:
                let s = mVal.getStr()
                if s notin opts:
                  errors.add("Route '" & name & "' matches choice value '" & s & "' not present in question '" & qPrefix & "' options " & $opts)
              elif mVal.kind == JArray:
                for item in mVal:
                  if item.kind == JString and item.getStr() notin opts:
                    errors.add("Route '" & name & "' matches choice value '" & item.getStr() & "' not present in question '" & qPrefix & "' options " & $opts)

      # Target validation
      if not rNode.hasKey("target") or rNode["target"].kind != JObject:
        errors.add("Route '" & name & "' missing 'target' object")
      else:
        let tNode = rNode["target"]
        let queue = tNode.getOrDefault("queue").getStr("")
        if queue.strip().len == 0:
          errors.add("Route '" & name & "' target missing required 'queue' string")
        elif not (queue.startsWith("queue:swarm:") or queue.startsWith("queue:worker:") or
                  queue.startsWith("swarm:") or queue.startsWith("worker:") or "{{" in queue):
          warnings.add("Route '" & name & "' queue '" & queue & "' does not match standard convention 'queue:swarm:<tag>' or 'queue:worker:<agent>'")

        if tNode.hasKey("lease_seconds"):
          if tNode["lease_seconds"].kind != JInt or tNode["lease_seconds"].getInt() <= 0:
            errors.add("Route '" & name & "' lease_seconds must be a positive integer")

  # Limits validation
  if root.hasKey("limits") and root["limits"].kind == JObject:
    let lNode = root["limits"]
    let chunkSize = lNode.getOrDefault("chunk_size").getInt(8000)
    let chunkOverlap = lNode.getOrDefault("chunk_overlap").getInt(800)
    let maxChunks = lNode.getOrDefault("max_chunks").getInt(10)
    if chunkSize <= 0:
      errors.add("limits.chunk_size must be a positive integer")
    if chunkOverlap < 0 or chunkOverlap >= chunkSize:
      errors.add("limits.chunk_overlap must be >= 0 and less than chunk_size")
    if maxChunks <= 0:
      errors.add("limits.max_chunks must be a positive integer")

  # Optional live service check
  if checkService and errors.len == 0:
    var serviceUrl = "http://127.0.0.1:8000"
    if root.hasKey("service") and root["service"].hasKey("url"):
      serviceUrl = root["service"]["url"].getStr("http://127.0.0.1:8000")
    serviceUrl = getEnv("RHIZO_SYSTEMONE_URL", getEnv("RHIZO_LAYA_URL", serviceUrl))

    var client = newHttpClient(timeout = 3000)
    try:
      var resp = client.get(serviceUrl & "/healthz")
      if resp.code != Http200:
        # Fallback to root or v1/models for Kev/Decider/Jev servers
        resp = client.get(serviceUrl & "/")
        if resp.code != Http200 and resp.code != Http404 and resp.code != Http405:
          errors.add("System 1 service at " & serviceUrl & " returned HTTP " & $resp.code)
    except CatchableError as e:
      errors.add("Cannot connect to System 1 service at " & serviceUrl & ": " & e.msg)
    finally:
      client.close()

  return (errors.len == 0, errors, warnings)

# Lint file directly
proc lintRoutesConfigFile*(filePath: string, checkService: bool = false): tuple[valid: bool, errors: seq[string], warnings: seq[string]] =
  if not fileExists(filePath):
    return (false, @["File does not exist: " & filePath], @[])
  try:
    let content = readFile(filePath)
    return lintYamlContent(content, checkService)
  except CatchableError as e:
    return (false, @["Failed to read file: " & e.msg], @[])

# Parse full configuration from YAML content
proc parseRoutesConfig*(yamlContent: string, configPath: string = ""): RoutingConfig =
  var doc: seq[JsonNode]
  try:
    var s = yamlContent
    doc = loadToJson(s)
  except CatchableError as e:
    raise newException(ValueError, "Failed to parse YAML route config: " & e.msg)

  if doc.len == 0 or doc[0] == nil or doc[0].kind != JObject:
    raise newException(ValueError, "Route config root must be a YAML mapping")

  let root = doc[0]
  result.configPath = configPath
  result.version = root.getOrDefault("version").getStr("1.0")
  result.service = defaultServiceConfig()
  result.limits = defaultRoutingLimits()
  result.questions = initTable[string, QuestionConfig]()
  result.routes = @[]

  # Parse service
  if root.hasKey("service") and root["service"].kind == JObject:
    let sNode = root["service"]
    result.service.url = sNode.getOrDefault("url").getStr(result.service.url)
    result.service.model = sNode.getOrDefault("model").getStr("")
    result.service.apiKey = sNode.getOrDefault("api_key").getStr("")
    if sNode.hasKey("timeout_seconds"):
      if sNode["timeout_seconds"].kind == JFloat:
        result.service.timeoutSeconds = sNode["timeout_seconds"].getFloat()
      elif sNode["timeout_seconds"].kind == JInt:
        result.service.timeoutSeconds = float(sNode["timeout_seconds"].getInt())

  # Env overrides
  let envUrl = getEnv("RHIZO_SYSTEMONE_URL", getEnv("RHIZO_LAYA_URL", ""))
  if envUrl.len > 0: result.service.url = envUrl
  let envModel = getEnv("RHIZO_SYSTEMONE_MODEL", "")
  if envModel.len > 0: result.service.model = envModel
  let envKey = getEnv("RHIZO_SYSTEMONE_API_KEY", "")
  if envKey.len > 0: result.service.apiKey = envKey
  let envTimeout = getEnv("RHIZO_ROUTE_TIMEOUT", "")
  if envTimeout.len > 0:
    try: result.service.timeoutSeconds = parseFloat(envTimeout)
    except ValueError: discard

  # Parse limits
  if root.hasKey("limits") and root["limits"].kind == JObject:
    let lNode = root["limits"]
    result.limits.overflowStrategy = parseOverflowStrategy(lNode.getOrDefault("overflow_strategy").getStr("split_aggregate"))
    result.limits.chunkSize = lNode.getOrDefault("chunk_size").getInt(8000)
    result.limits.chunkOverlap = lNode.getOrDefault("chunk_overlap").getInt(800)
    result.limits.splitDelimiter = lNode.getOrDefault("split_delimiter").getStr("\n")
    result.limits.maxChunks = lNode.getOrDefault("max_chunks").getInt(10)
    if lNode.hasKey("defaults") and lNode["defaults"].kind == JObject:
      let dNode = lNode["defaults"]
      result.limits.defaultChoiceAgg = parseChoiceAgg(dNode.getOrDefault("choice").getStr("max_confidence"))
      result.limits.defaultScoreAgg = parseScoreAgg(dNode.getOrDefault("score").getStr("max"))
      result.limits.defaultNoulAgg = parseNoulAgg(dNode.getOrDefault("noul").getStr("any"))

  # Parse questions
  if root.hasKey("questions") and root["questions"].kind == JObject:
    for qid, qNode in root["questions"]:
      if qNode.kind != JObject: continue
      var qc = QuestionConfig(
        id: qid,
        qType: qNode.getOrDefault("type").getStr("choice").toLowerAscii,
        instructions: qNode.getOrDefault("instructions").getStr(""),
        options: @[],
        criteria: @[],
        rawNode: qNode,
        choiceAgg: result.limits.defaultChoiceAgg,
        scoreAgg: result.limits.defaultScoreAgg,
        noulAgg: result.limits.defaultNoulAgg
      )
      if qNode.hasKey("aggregate"):
        let aStr = qNode["aggregate"].getStr("")
        qc.choiceAgg = parseChoiceAgg(aStr, result.limits.defaultChoiceAgg)
        qc.scoreAgg = parseScoreAgg(aStr, result.limits.defaultScoreAgg)
        qc.noulAgg = parseNoulAgg(aStr, result.limits.defaultNoulAgg)

      if qNode.hasKey("options") and qNode["options"].kind == JArray:
        for o in qNode["options"]: qc.options.add(o.getStr())
      elif qNode.hasKey("criteria") and qNode["criteria"].kind == JObject:
        for k, _ in qNode["criteria"]: qc.options.add(k)
      elif qNode.hasKey("criteria") and qNode["criteria"].kind == JArray:
        for o in qNode["criteria"]:
          qc.options.add(o.getStr())
          qc.criteria.add(o.getStr())

      result.questions[qid] = qc

  # Parse routes
  if root.hasKey("routes") and root["routes"].kind == JArray:
    for idx, rNode in root["routes"].elems:
      if rNode.kind != JObject: continue
      var rule = RouteRule(
        name: rNode.getOrDefault("name").getStr("rule-" & $idx),
        conditions: @[],
        target: RouteTarget(queue: "", tags: @[], leaseSeconds: 1800)
      )

      if rNode.hasKey("match") and rNode["match"].kind == JObject:
        for mKey, mVal in rNode["match"]:
          var cond = MatchCondition(key: mKey)
          if mVal.kind == JString:
            cond.operator = "eq"
            cond.strValue = mVal.getStr()
          elif mVal.kind == JArray:
            cond.operator = "in"
            cond.seqValue = @[]
            for item in mVal: cond.seqValue.add(item.getStr())
          elif mVal.kind == JObject:
            # Score or probability comparisons: { gte: 1.5, lt: 0.2, etc. }
            for op, valNode in mVal:
              cond.operator = op.toLowerAscii
              if valNode.kind == JFloat: cond.floatValue = valNode.getFloat()
              elif valNode.kind == JInt: cond.floatValue = float(valNode.getInt())
          rule.conditions.add(cond)

      if rNode.hasKey("target") and rNode["target"].kind == JObject:
        let tNode = rNode["target"]
        rule.target.queue = tNode.getOrDefault("queue").getStr("")
        rule.target.leaseSeconds = tNode.getOrDefault("lease_seconds").getInt(1800)
        if tNode.hasKey("tags") and tNode["tags"].kind == JArray:
          for t in tNode["tags"]: rule.target.tags.add(t.getStr())

      result.routes.add(rule)

# Split oversized input into chunks respecting limits
proc splitIntoChunks*(text: string, limits: RoutingLimits): seq[string] =
  if text.len <= limits.chunkSize:
    return @[text]

  case limits.overflowStrategy
  of osFailFast:
    raise newException(ValueError, "Input length (" & $text.len & " chars) exceeds limits.chunk_size (" &
                                   $limits.chunkSize & " chars) and overflow_strategy is fail_fast")

  of osLeadTail:
    let budget = limits.chunkSize
    let headLen = int(float(budget) * 0.45)
    let tailLen = int(float(budget) * 0.45)
    let marker = "\n\n[... truncated " & $(text.len - headLen - tailLen) & " characters of middle context ...]\n\n"
    return @[text[0 ..< headLen] & marker & text[^tailLen .. ^1]]

  of osSplitAggregate:
    result = @[]
    var curPos = 0
    let step = max(1, limits.chunkSize - limits.chunkOverlap)

    while curPos < text.len:
      if result.len >= limits.maxChunks:
        raise newException(ValueError, "Input requires more chunks than configured limits.max_chunks (" &
                                       $limits.maxChunks & "). Increase max_chunks or summarize text.")

      let remain = text.len - curPos
      if remain <= limits.chunkSize:
        result.add(text[curPos .. ^1])
        break

      # Look for natural split delimiter near the end of chunkSize
      let windowEnd = curPos + limits.chunkSize
      var cutPos = windowEnd
      if limits.splitDelimiter.len > 0:
        let searchBackLimit = max(curPos + step, windowEnd - (limits.chunkOverlap div 2))
        let delimIdx = text.rfind(limits.splitDelimiter, searchBackLimit, windowEnd)
        if delimIdx > 0 and delimIdx > curPos:
          cutPos = delimIdx + limits.splitDelimiter.len

      result.add(text[curPos ..< cutPos])
      curPos = curPos + step
      if curPos >= text.len: break

# Multi-chunk question-level aggregation
proc aggregateChunkAnswers*(
  chunksAnswers: seq[JsonNode],
  questions: Table[string, QuestionConfig]
): (JsonNode, JsonNode) =
  var aggAnswers = newJObject()
  var metaAnswers = newJObject()

  if chunksAnswers.len == 0:
    return (aggAnswers, metaAnswers)

  if chunksAnswers.len == 1:
    let single = chunksAnswers[0]
    var meta = %*{
      "chunks_evaluated": 1,
      "strategy": "direct"
    }
    return (single, meta)

  let numChunks = chunksAnswers.len

  for qid, qc in questions:
    case qc.qType
    of "choice":
      case qc.choiceAgg
      of caMaxConfidence:
        var maxConf = -1.0
        var bestNode: JsonNode = nil
        var bestChunkIdx = 0
        for idx, ca in chunksAnswers:
          if ca.hasKey(qid) and ca[qid].hasKey("confidence"):
            let conf = ca[qid]["confidence"].getFloat(0.0)
            if conf > maxConf:
              maxConf = conf
              bestNode = ca[qid]
              bestChunkIdx = idx + 1
        if bestNode != nil:
          aggAnswers[qid] = bestNode
          metaAnswers[qid] = %*{
            "aggregate_strategy": "max_confidence",
            "winning_chunk": bestChunkIdx,
            "confidence": maxConf
          }
        else:
          aggAnswers[qid] = chunksAnswers[0].getOrDefault(qid)

      of caMeanProb:
        var probSums = initTable[string, float]()
        var counts = initTable[string, int]()
        for ca in chunksAnswers:
          if ca.hasKey(qid) and ca[qid].hasKey("probabilities"):
            for opt, pVal in ca[qid]["probabilities"]:
              probSums[opt] = probSums.getOrDefault(opt, 0.0) + pVal.getFloat(0.0)
              counts[opt] = counts.getOrDefault(opt, 0) + 1

        var bestOpt = ""
        var maxProb = -1.0
        var avgProbNode = newJObject()
        for opt, sumVal in probSums:
          let avgP = sumVal / float(max(1, counts.getOrDefault(opt, 1)))
          avgProbNode[opt] = %avgP
          if avgP > maxProb:
            maxProb = avgP
            bestOpt = opt

        var node = newJObject()
        node["type"] = %"choice"
        node["choice"] = %bestOpt
        node["confidence"] = %maxProb
        node["probabilities"] = avgProbNode
        aggAnswers[qid] = node
        metaAnswers[qid] = %*{
          "aggregate_strategy": "mean_prob",
          "choice": bestOpt
        }

      of caMajorityVote:
        var votes = initTable[string, int]()
        for ca in chunksAnswers:
          if ca.hasKey(qid) and ca[qid].hasKey("choice"):
            let c = ca[qid]["choice"].getStr()
            votes[c] = votes.getOrDefault(c, 0) + 1

        var topChoice = ""
        var topVotes = -1
        for c, count in votes:
          if count > topVotes:
            topVotes = count
            topChoice = c

        var node = newJObject()
        node["type"] = %"choice"
        node["choice"] = %topChoice
        aggAnswers[qid] = node
        metaAnswers[qid] = %*{
          "aggregate_strategy": "majority_vote",
          "choice": topChoice,
          "votes": topVotes
        }

    of "score":
      var scores: seq[float] = @[]
      for ca in chunksAnswers:
        if ca.hasKey(qid) and ca[qid].hasKey("score"):
          scores.add(ca[qid]["score"].getFloat(0.0))

      if scores.len == 0:
        aggAnswers[qid] = chunksAnswers[0].getOrDefault(qid)
        continue

      var finalScore = 0.0
      case qc.scoreAgg
      of saMax:
        finalScore = scores[0]
        for s in scores:
          if s > finalScore: finalScore = s
      of saMin:
        finalScore = scores[0]
        for s in scores:
          if s < finalScore: finalScore = s
      of saMean:
        var sum = 0.0
        for s in scores: sum += s
        finalScore = sum / float(scores.len)
      of saSum:
        var sum = 0.0
        for s in scores: sum += s
        finalScore = sum

      var node = newJObject()
      node["type"] = %"score"
      node["score"] = %finalScore
      aggAnswers[qid] = node
      metaAnswers[qid] = %*{
        "aggregate_strategy": $qc.scoreAgg,
        "score": finalScore,
        "chunk_scores": %scores
      }

    of "noul":
      var noulVals: seq[float] = @[]
      for ca in chunksAnswers:
        if ca.hasKey(qid):
          let sub = ca[qid]
          if sub.hasKey("noul"):
            if sub["noul"].kind == JFloat: noulVals.add(sub["noul"].getFloat())
            elif sub["noul"].kind == JInt: noulVals.add(float(sub["noul"].getInt()))
            elif sub["noul"].kind == JBool: noulVals.add(if sub["noul"].getBool(): 1.0 else: 0.0)

      if noulVals.len == 0:
        aggAnswers[qid] = chunksAnswers[0].getOrDefault(qid)
        continue

      var finalVal = 0.0
      case qc.noulAgg
      of naAny:
        for v in noulVals:
          if v >= 0.5:
            finalVal = v
            break
      of naAll:
        var allTrue = true
        for v in noulVals:
          if v < 0.5: allTrue = false; break
        finalVal = if allTrue: 1.0 else: 0.0
      of naMean:
        var sum = 0.0
        for v in noulVals: sum += v
        finalVal = sum / float(noulVals.len)

      var node = newJObject()
      node["type"] = %"noul"
      node["noul"] = %finalVal
      aggAnswers[qid] = node
      metaAnswers[qid] = %*{
        "aggregate_strategy": $qc.noulAgg,
        "noul": finalVal
      }
    else:
      aggAnswers[qid] = chunksAnswers[0].getOrDefault(qid)

  var fullMeta = %*{
    "strategy": "split_aggregate",
    "chunks_evaluated": numChunks,
    "answers": metaAnswers
  }
  return (aggAnswers, fullMeta)

# Helper to resolve string interpolation: {{ question.field }} -> value
proc interpolateString(templateStr: string, answers: JsonNode): string =
  result = templateStr
  while "{{" in result and "}}" in result:
    let startIdx = result.find("{{")
    let endIdx = result.find("}}", startIdx)
    if startIdx < 0 or endIdx < 0: break

    let rawKey = result[startIdx + 2 ..< endIdx].strip()
    var repl = ""
    let parts = rawKey.split('.')
    if parts.len == 1:
      if answers.hasKey(parts[0]):
        let n = answers[parts[0]]
        if n.kind == JString: repl = n.getStr()
        elif n.hasKey("choice"): repl = n["choice"].getStr()
        elif n.hasKey("score"): repl = $n["score"].getFloat()
    elif parts.len >= 2:
      let qid = parts[0]
      let field = parts[1]
      if answers.hasKey(qid) and answers[qid].hasKey(field):
        let n = answers[qid][field]
        if n.kind == JString: repl = n.getStr()
        elif n.kind == JFloat: repl = $n.getFloat()
        elif n.kind == JInt: repl = $n.getInt()
        elif n.kind == JBool: repl = $n.getBool()

    result = result[0 ..< startIdx] & repl & result[endIdx + 2 .. ^1]

# Evaluate matching rules against final answers
proc evaluateRules*(rules: seq[RouteRule], answers: JsonNode, meta: JsonNode): RoutingDecision =
  for rule in rules:
    var allMatched = true

    for cond in rule.conditions:
      let parts = cond.key.split('.')
      let qid = parts[0]
      let field = if parts.len > 1: parts[1] else: ""

      if not answers.hasKey(qid):
        allMatched = false
        break

      let qNode = answers[qid]

      case cond.operator
      of "eq":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getStr()
                     elif qNode.hasKey("choice"): qNode["choice"].getStr()
                     elif qNode.kind == JString: qNode.getStr()
                     else: ""
        if actual != cond.strValue:
          allMatched = false
          break

      of "in":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getStr()
                     elif qNode.hasKey("choice"): qNode["choice"].getStr()
                     elif qNode.kind == JString: qNode.getStr()
                     else: ""
        if actual notin cond.seqValue:
          allMatched = false
          break

      of "gte":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getFloat(0.0)
                     elif qNode.hasKey("score"): qNode["score"].getFloat(0.0)
                     elif qNode.kind == JFloat: qNode.getFloat()
                     else: 0.0
        if actual < cond.floatValue:
          allMatched = false
          break

      of "gt":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getFloat(0.0)
                     elif qNode.hasKey("score"): qNode["score"].getFloat(0.0)
                     else: 0.0
        if actual <= cond.floatValue:
          allMatched = false
          break

      of "lte":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getFloat(0.0)
                     elif qNode.hasKey("score"): qNode["score"].getFloat(0.0)
                     else: 0.0
        if actual > cond.floatValue:
          allMatched = false
          break

      of "lt":
        let actual = if field.len > 0 and qNode.hasKey(field): qNode[field].getFloat(0.0)
                     elif qNode.hasKey("score"): qNode["score"].getFloat(0.0)
                     else: 0.0
        if actual >= cond.floatValue:
          allMatched = false
          break

      else:
        allMatched = false
        break

    if allMatched:
      let targetQ = interpolateString(rule.target.queue, answers)
      var finalTags: seq[string] = @[]
      for t in rule.target.tags:
        finalTags.add(interpolateString(t, answers))

      return RoutingDecision(
        matchedRule: rule.name,
        targetQueue: targetQ,
        tags: finalTags,
        leaseSeconds: rule.target.leaseSeconds,
        rawAnswers: answers,
        aggregationMetadata: meta
      )

  # Fail-Fast: Zero graceful degradation
  raise newException(ValueError, "No route rule matched Laya classification results: " & $answers)

# Call Laya System 1 endpoint with strict timeout and diagnostics
proc callLayaSystemOne*(
  service: RoutingServiceConfig,
  stateText: string,
  questions: Table[string, QuestionConfig]
): JsonNode =
  var qDict = newJObject()
  for qid, qc in questions:
    if qc.rawNode != nil:
      qDict[qid] = qc.rawNode
    else:
      var qn = newJObject()
      qn["type"] = %qc.qType
      qn["instructions"] = %qc.instructions
      if qc.options.len > 0: qn["options"] = %qc.options
      elif qc.criteria.len > 0: qn["criteria"] = %qc.criteria
      qDict[qid] = qn

  var reqBody = %*{
    "state": stateText,
    "questions": qDict
  }
  if service.model.len > 0:
    reqBody["model"] = %service.model

  let timeoutMs = int(service.timeoutSeconds * 1000)
  var client = newHttpClient(timeout = timeoutMs)
  var headers = newHttpHeaders({"Content-Type": "application/json"})
  if service.apiKey.len > 0:
    headers["Authorization"] = "Bearer " & service.apiKey
  client.headers = headers

  let endpoint = service.url.strip(chars = {'/'}) & "/v1/systemone"

  var respStr = ""
  try:
    respStr = client.postContent(endpoint, body = $reqBody)
  except HttpRequestError as e:
    stderr.writeLine("Error: System 1 service returned HTTP error at " & endpoint & ": " & e.msg)
    quit(1)
  except TimeoutError:
    stderr.writeLine("Error: System 1 service timed out after " & $service.timeoutSeconds &
                     "s at " & endpoint & ". Service may be overloaded or hung.")
    quit(1)
  except CatchableError as e:
    stderr.writeLine("Error: System 1 service is unreachable at " & endpoint & " (" & e.msg & ").")
    stderr.writeLine("Start your System 1 service (Laya, Kev, Decider, or Ollaya) before routing tasks.")
    quit(1)
  finally:
    client.close()

  try:
    let parsed = parseJson(respStr)
    if parsed.hasKey("answers"):
      return parsed["answers"]
    return parsed
  except CatchableError as e:
    stderr.writeLine("Error: Failed to parse Laya response JSON: " & e.msg)
    stderr.writeLine("Raw response: " & respStr)
    quit(1)

# Full end-to-end task routing pipeline
proc routeTask*(cfg: RoutingConfig, text: string): RoutingDecision =
  let chunks = splitIntoChunks(text, cfg.limits)
  var chunkResults: seq[JsonNode] = @[]

  for c in chunks:
    let ans = callLayaSystemOne(cfg.service, c, cfg.questions)
    chunkResults.add(ans)

  let (aggAnswers, meta) = aggregateChunkAnswers(chunkResults, cfg.questions)
  return evaluateRules(cfg.routes, aggAnswers, meta)
