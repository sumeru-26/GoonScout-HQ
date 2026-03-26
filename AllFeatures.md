Before we start there are a few things that have been updated the scouting data that is scanned now looks like this:

{
"t": "", // timeline string (events)
"s": "", // text data (compressed)
"b": [] // metadata array for slider asset(not button slider) and toggles
“d”: [] // match number, team number, scouter name
“p”:[] // x and y position of the robot
“ft”: [] // scouting type 0 for match, 1 for qualitative, and 2 for pit
}

{"t":"","s":"||","b":[0,50],"d":[1,"","ugig"],"p":[0.726592,0.759827],"ft":[0]}

Here is the one without event time tracking:

{"0":0,"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0,"16":false,"17":"","18":"","19":"","20":50,"10.s":0,"11.s":0,"10.f":0,"11.f":0,"match":1,"team":"","scouter":"adad","p":[0.388082,0.650504],"ft":[0]}

Please adjust the clean payload accordingly also the md for reconstructing the field will be used to put into context the x and y position onto the field. 



okay there are a lot of changes that must be made, this is a big update. First of all i’ve added a .env file with these things [DIRECT_URL (supabase), DATABASE_URL (supabase), NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL, X_TBA_AUTH_KEY (the blue aliance)] please make all the connections that you need to in order to fully connect this to the supabase backend and blue alliance also please look at the #file:prisma  folder to understand the current backend structure. Now I will walk you through the workflow, inside the home page there should be a button to set the root folder this will act as the local backend storage. next up when you create a project it will prompt you to enter a name and also enter the content_hash from the editor you should match and test if it’s a valid one by looking in the field_configs table and seeing if it has one with a matching hash. If it does then it will let you create the new game. inside the configs tab inside the new project just created you should be able to edit the current content hash of the project as well as add a qualitative scout match as well as a pit scout content hash please test to make sure that the entered hash has the proper scouting type inside the payload attached to the content hash here is what it should look inside the payload [should look like this in payload: "scoutType":"match"] next up please look at the this md file it will explain a major update to the current json system and how to uncompress the scanned json. 

Here is what compressed data will look like:

This is if eventTimetracking is enabled:

{
  "t": "10:139:1:s,10:210:1:f,10:265:1:f,10:313:1:s,10:378:1:s,0:515:3,0:530:3,0:545:3,0:560:3,0:574:3,8:730:69,6:861:10,12:934:1,3:1428:1,1:1607:3,1:1622:3,1:1636:3,1:1652:3,1:1665:3,1:1679:3,9:1832:83,7:1923:10,15:2003:1",
  "s": "thats rly good|they suck|WOWO",
  "b": [0,50],
  "d": [6,2374,"wdadw"]
}
This is if its disabled:

{
  "0":24,
  "1":33,
  "2":0,
  "3":0,
  "4":0,
  "5":0,
  "6":12,
  "7":9,
  "8":0,
  "9":0,
  "10":0,
  "11":0,
  "12":2,
  "13":0,
  "14":0,
  "15":1,
  "16":false,
  "17":"good stuff",
  "18":"bad stuff",
  "19":"idk bro",
  "20":50,
  "10.s":2,
  "11.s":0,
  "10.f":1,
  "11.f":0,
  "match":4,
  "team":"5937",
  "scouter":"daw"
}



Here is the md that will explain how to uncompress all this data
# GoonScout Compressed Payload Decompression Guide (Lossless)

This document explains, in **implementation-level detail**, how to decode both compressed payload formats into rich scouting JSON without losing information.

It is designed so another AI (or developer) can implement decoding deterministically and produce output like your two target formats.

---

## 1) Purpose and Scope

This guide covers **both** input formats:

1. **Event-time-tracking enabled** (timeline format)
   - Shape: `{ t: string, s: string, b: array, d: array }`
2. **Event-time-tracking disabled** (flat compact mapped IDs)
   - Shape: `{ "0": 24, "1": 33, ..., "10.s": 2, "10.f": 1, match, team, scouter }`

And maps them into expanded JSON shaped like:

- Mode-aware buckets (`auto`, `teleop`)
- Metric objects (`l1`, `passing`, `outpost`, etc.)
- Optional timeline `events` arrays (only with time tracking)
- Accuracy/attempt stats for metrics listed in `field_mapping.success`
- Text/meta restoration via `field_mapping.text` / `field_mapping.meta`

---

## 2) Required Inputs

Decoder requires:

1. `compressedPayload` (one of the two compressed formats)
2. `fieldMappingJson` with this structure:

```json
{
  "meta": [16, 20],
  "text": [17, 18, 19],
  "mapping": {
    "0": "auto.fuel",
    "1": "teleop.fuel",
    "2": "auto.l1",
    "3": "teleop.l1",
    "4": "auto.l3",
    "5": "teleop.l3",
    "6": "auto.passing",
    "7": "teleop.passing",
    "8": "auto.defense",
    "9": "teleop.defense",
    "10": "auto.outpost",
    "11": "teleop.outpost",
    "12": "auto.depot",
    "13": "teleop.depot",
    "14": "auto.humanplayer",
    "15": "teleop.humanplayer",
    "16": "bricked",
    "17": "good",
    "18": "bad",
    "19": "area",
    "20": "slider"
  },
  "success": [10, 11]
}
```

---

## 3) Core Concepts

## 3.1 ID ↔ Tag map

Build both directions:

- `idToTag`: from `mapping` (`"10" -> "auto.outpost"`)
- `tagToId`: inverse (`"auto.outpost" -> "10"`)

All compressed data uses IDs; all expanded output uses human-readable names.

## 3.2 Mode + metric

For mapped tags like `"auto.outpost"`, split at first dot:

- mode = `auto`
- metric = `outpost`

Supported mode keys for nested output:

- `auto`
- `teleop`

## 3.3 Success metrics

`success` array in field mapping contains IDs whose events/counters include success/fail semantics.

For these metrics:

- attempts = successes + fails
- accuracy = successes / attempts (0 if attempts = 0)

---

## 4) Detect Which Compressed Format You Have

Use strict shape detection:

### Event-time-tracking enabled if:

- payload has key `t` (string), and
- payload has key `s` (string), and
- payload has key `b` (array), and
- payload has key `d` (array)

### Otherwise treat as disabled flat format:

- payload has many numeric string keys (`"0"`, `"1"`, ...)
- may include success suffix keys (`"10.s"`, `"10.f"`)

---

## 5) Output Shape Targets

## 5.1 Shared top-level fields

Always restore these top-level fields when available:

- `match`
- `team`
- `scouter`
- all non-mode scalar tags (e.g. `bricked`, `slider`, `good`, `bad`, `area`)

## 5.2 Mode buckets

Create:

- `auto: {}`
- `teleop: {}`

Populate each mode with decoded metrics.

---

## 6) Decompressing Event-Time-Tracking Enabled Payload

Input shape:

```json
{
  "t": "10:139:1:s,0:515:3,8:730:69,...",
  "s": "thats rly good|they suck|WOWO",
  "b": [0,50],
  "d": [6,2374,"wdadw"]
}
```

## 6.1 Decode `d` (match metadata)

`d` index order is fixed:

- `d[0]` = `match`
- `d[1]` = `team`
- `d[2]` = `scouter`

Preserve team type as provided (string or number); if your target schema expects string, stringify.

## 6.2 Decode `s` (text values)

1. Split `s` by `|` into list `textParts`
2. Iterate `fieldMapping.text` by index order
3. For each text ID at index `i`:
   - tag = `idToTag[textId]` (e.g. `17 -> good`)
   - value = `textParts[i]` if present else `""`
   - assign output[tag] = value

Important:
- Preserve order from `fieldMapping.text`
- Do not reorder by tag name

## 6.3 Decode `b` (meta values)

1. Iterate `fieldMapping.meta` by index order
2. For each meta ID at index `i`:
   - tag = `idToTag[metaId]`
   - raw = `b[i]` if present else `0`
3. Type handling:
   - if tag is boolean metric (e.g. `bricked`), map 0/1 to false/true
   - if tag is slider-like metric (`slider`), keep numeric
   - fallback: keep numeric raw

Recommended boolean rule:
- If raw is boolean, keep it
- Else boolean = `Number(raw) !== 0`

## 6.4 Decode `t` timeline events

Timeline token format:

- normal event: `id:timeCs:value`
- success event: `id:timeCs:value:s`
- fail event: `id:timeCs:value:f`

Where:
- `id` = mapping ID as integer/string
- `timeCs` = centiseconds from match timeline start
- `value` = increment OR hold duration (also centiseconds for hold metrics)
- optional `s`/`f` only for success metrics

### Parsing algorithm

1. If `t` is empty string, no timeline events.
2. Else split by comma into event tokens.
3. For each token:
   - split by `:`
   - must have length 3 or 4
   - parts:
     - `idPart`
     - `timePart`
     - `valuePart`
     - optional `resultPart` (`s` or `f`)
4. Resolve tag via `idToTag[idPart]`. If unknown ID, store in `unknownEvents[]` (optional) and skip or preserve externally.
5. For known tag:
   - if tag has mode prefix (`auto.`/`teleop.`), route into that bucket
   - metric name = suffix after first dot
   - eventTimeSeconds = `timeCs / 100`

### Event object shape

For non-defense non-hold metrics:

```json
{ "time": 5.15, "value": 3 }
```

For success/fail events:

```json
{ "time": 1.39, "value": 1, "result": "success" }
```

For hold-time defense-style metrics:

```json
{ "time": 7.30, "duration": 0.69 }
```

Use hold interpretation for metrics named `defense` when value represents held centiseconds.

## 6.5 Aggregate timeline into totals and stats

For each mode.metric group:

### If metric is `defense`

- `totalTimeHeld` = sum(event.duration)
- Keep `events` as `{time, duration}`

### Else if metric ID is in `success[]`

- `total` = sum(event.value)
- `successes` = count events with result=`success`
- `fails` = count events with result=`fail`
- `attempts` = `successes + fails`
- `accuracy` = `attempts > 0 ? round(successes/attempts, 2) : 0`
- keep `events`

### Else

- `total` = sum(event.value)
- keep `events`

## 6.6 Handling metrics with no events

If a mode.metric exists in mapping but never appears in timeline:
- You may omit it for compactness
- Or include with zero totals if your consumer requires fixed schema

Given your examples, both patterns are acceptable depending on usage.

---

## 7) Decompressing Event-Time-Tracking Disabled Payload

Input shape example:

```json
{
  "0":24,
  "1":33,
  "10.s":2,
  "10.f":1,
  "16":false,
  "17":"good stuff",
  "18":"bad stuff",
  "19":"idk bro",
  "20":50,
  "match":4,
  "team":"5937",
  "scouter":"daw"
}
```

## 7.1 Extract shared metadata

Read directly:

- `match`
- `team`
- `scouter`

## 7.2 Decode base ID keys (`"0"`, `"1"`, ...)

For each numeric key in payload:

1. Resolve tag with `idToTag`
2. If tag has mode prefix:
   - place under `auto` / `teleop`
3. Else place as top-level scalar (`bricked`, `slider`, `good`, `bad`, `area`)

### Metric interpretation for mode tags

Given value = numeric total/count:

- For simple count metrics (e.g. `fuel`, `depot`, `humanplayer`) use:
  - either scalar (`fuel: 24`) or object (`{ total: 24 }`) depending on target schema
- For `defense`, convert to seconds for readable output:
  - `defenseTimeHeld = rawCentiseconds / 100`
- For success-capable metrics (IDs in `success[]`), enrich with attempts/accuracy using suffix keys.

## 7.3 Decode success suffix keys (`id.s`, `id.f`)

Parse keys matching regex:

- `^(\d+)\.(s|f)$`

For each:

- `id` -> mapping tag (e.g. `10 -> auto.outpost`)
- suffix `s` = success count
- suffix `f` = fail count

For that mode.metric:

- `successes = payload[id.s] || 0`
- `fails = payload[id.f] || 0`
- `attempts = successes + fails`
- `accuracy = attempts > 0 ? round(successes / attempts, 2) : 0`
- `total = payload[id] || 0`

If metric has success data but missing base total, set total = 0.

## 7.4 Top-level non-mode keys from mapping

Keys like `16`, `17`, `18`, `19`, `20` map to:

- `bricked` (boolean)
- `good`/`bad`/`area` (strings)
- `slider` (number)

Preserve types where possible.

---

## 8) Recommended Canonical Reconstruction Rules

To avoid data loss and keep outputs consistent:

1. **Never drop unknown IDs silently**
   - collect in `_unknown` or logs.
2. **Preserve all parsed values before rounding/formatting**
   - internal math can use full precision; round only presentation fields.
3. **Keep event order stable**
   - timeline order = chronological order in source string.
4. **Accuracy precision**
   - use 2 decimals (`0.67`) unless your client needs more.
5. **Type safety**
   - convert missing/invalid numeric values to 0 (or empty string for text slots).

---

## 9) Detailed Pseudocode (Reference)

```ts
function decodeCompressed(payload, fieldMapping) {
  const idToTag = fieldMapping.mapping
  const successIds = new Set((fieldMapping.success ?? []).map(String))

  if (isTimelinePayload(payload)) {
    return decodeTimelinePayload(payload, fieldMapping, idToTag, successIds)
  }

  return decodeFlatPayload(payload, fieldMapping, idToTag, successIds)
}

function isTimelinePayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.t === "string" &&
    typeof p.s === "string" &&
    Array.isArray(p.b) &&
    Array.isArray(p.d)
  )
}

function decodeTimelinePayload(p, fm, idToTag, successIds) {
  const out = { auto: {}, teleop: {} }

  // d
  out.match = toInt(p.d[0], 0)
  out.team = p.d[1] ?? ""
  out.scouter = String(p.d[2] ?? "")

  // s
  const textParts = p.s.length ? p.s.split("|") : []
  ;(fm.text ?? []).forEach((id, i) => {
    const tag = idToTag[String(id)]
    if (!tag) return
    out[tag] = textParts[i] ?? ""
  })

  // b
  ;(fm.meta ?? []).forEach((id, i) => {
    const tag = idToTag[String(id)]
    if (!tag) return
    const raw = p.b[i] ?? 0
    out[tag] = normalizeMetaValue(tag, raw)
  })

  // t
  const grouped = new Map() // key: mode.metric => event[]

  if (p.t.trim().length > 0) {
    for (const token of p.t.split(",")) {
      const parts = token.split(":")
      if (parts.length < 3 || parts.length > 4) continue

      const [idPart, timePart, valuePart, resultPart] = parts
      const tag = idToTag[idPart]
      if (!tag) continue

      const [mode, metric] = splitModeMetric(tag)
      if (!mode || !metric) continue

      const timeSec = toNum(timePart, 0) / 100
      const val = toNum(valuePart, 0)

      let evt
      if (metric === "defense") {
        evt = { time: round2(timeSec), duration: round2(val / 100) }
      } else {
        evt = { time: round2(timeSec), value: val }
        if (parts.length === 4 && successIds.has(idPart)) {
          evt.result = resultPart === "s" ? "success" : resultPart === "f" ? "fail" : undefined
        }
      }

      pushGrouped(grouped, `${mode}.${metric}`, evt)
    }
  }

  // aggregate
  for (const [key, events] of grouped.entries()) {
    const [mode, metric] = key.split(".")

    if (metric === "defense") {
      const totalTimeHeld = sum(events.map(e => e.duration || 0))
      out[mode][metric] = { totalTimeHeld: round2(totalTimeHeld), events }
      continue
    }

    const total = sum(events.map(e => e.value || 0))

    const tagId = findIdByTag(idToTag, `${mode}.${metric}`)
    if (tagId && successIds.has(tagId)) {
      const successes = events.filter(e => e.result === "success").length
      const fails = events.filter(e => e.result === "fail").length
      const attempts = successes + fails
      out[mode][metric] = {
        total,
        attempts,
        successes,
        fails,
        accuracy: attempts ? round2(successes / attempts) : 0,
        events,
      }
    } else {
      out[mode][metric] = { total, events }
    }
  }

  return out
}

function decodeFlatPayload(p, fm, idToTag, successIds) {
  const out = { auto: {}, teleop: {} }

  out.match = toInt(p.match, 0)
  out.team = p.team ?? ""
  out.scouter = String(p.scouter ?? "")

  // decode numeric ids
  for (const [k, v] of Object.entries(p)) {
    if (!/^\d+$/.test(k)) continue

    const tag = idToTag[k]
    if (!tag) continue

    const split = splitModeMetric(tag)
    if (!split) {
      out[tag] = normalizeTopLevel(tag, v)
      continue
    }

    const [mode, metric] = split
    const num = toNum(v, 0)

    if (metric === "defense") {
      out[mode].defenseTimeHeld = round2(num / 100)
    } else if (metric === "fuel") {
      out[mode].fuel = num
    } else {
      out[mode][metric] = { total: num }
    }
  }

  // apply success counters id.s/id.f
  for (const [k, v] of Object.entries(p)) {
    const m = k.match(/^(\d+)\.(s|f)$/)
    if (!m) continue

    const id = m[1]
    const kind = m[2]
    if (!successIds.has(id)) continue

    const tag = idToTag[id]
    if (!tag) continue

    const [mode, metric] = splitModeMetric(tag)
    if (!mode || !metric) continue

    if (!out[mode][metric]) out[mode][metric] = { total: toNum(p[id], 0) }

    const cur = out[mode][metric]
    if (kind === "s") cur.successes = toInt(v, 0)
    if (kind === "f") cur.fails = toInt(v, 0)

    const successes = cur.successes ?? 0
    const fails = cur.fails ?? 0
    const attempts = successes + fails

    cur.attempts = attempts
    cur.accuracy = attempts ? round2(successes / attempts) : 0
    if (cur.total == null) cur.total = toNum(p[id], 0)
  }

  // ensure text/meta restoration by ordered arrays if needed
  // (for flat payload these usually already appear as id keys)

  return out
}
```

---

## 10) Walkthrough With Your Provided Enabled Example

Input:

- `d = [6,2374,"wdadw"]` -> `match=6`, `team=2374`, `scouter="wdadw"`
- `s = "thats rly good|they suck|WOWO"`
  - `text=[17,18,19]`
  - `17->good`, `18->bad`, `19->area`
- `b = [0,50]`
  - `meta=[16,20]`
  - `16->bricked=false`, `20->slider=50`
- `t` events decoded by IDs:
  - `10` -> `auto.outpost` with `:s/:f` success stats
  - `0` -> `auto.fuel`
  - `8` -> `auto.defense` hold duration
  - etc.

This reconstructs exactly the expanded sample you provided.

---

## 11) Walkthrough With Your Provided Disabled Example

Input key highlights:

- `"0":24` -> `auto.fuel = 24`
- `"1":33` -> `teleop.fuel = 33`
- `"10":0`, `"10.s":2`, `"10.f":1` -> `auto.outpost.total=0`, attempts=3, successes=2, fails=1, accuracy=0.67
- `"16":false` -> `bricked=false`
- `"17":"good stuff"`, `"18":"bad stuff"`, `"19":"idk bro"`
- `"20":50` -> `slider=50`

This reconstructs exactly the no-time-tracking expanded shape you showed.

---

## 12) Losslessness Checklist

Use this checklist to verify no data loss:

1. Every ID key in compressed payload is either decoded or logged as unknown.
2. Every `text[]` slot maps to one output field (including empty strings).
3. Every `meta[]` slot maps to one output field.
4. Timeline preserves token count/order unless token invalid.
5. For success IDs, both event-level (`s/f`) and aggregate counters survive.
6. `match/team/scouter` always preserved.
7. Defense hold values remain recoverable in seconds and original centisecond totals if needed.

---

## 13) Suggested Optional Enhancements

If you want truly perfect reversibility for analytics + re-encoding:

- store raw compressed payload under `_rawCompressed`
- store unknown IDs/tokens under `_unknown`
- keep both rounded and raw numeric totals:
  - `totalTimeHeld` (seconds)
  - `_totalTimeHeldCs` (centiseconds)

---

## 14) Summary

To decode safely:

1. Load `field_mapping` and build `idToTag`.
2. Detect format (`t/s/b/d` vs flat IDs).
3. Decode shared metadata.
4. Decode text/meta using ordered arrays.
5. Decode metric IDs into `auto/teleop` buckets.
6. Apply success logic using `success[]` + `id.s/id.f` or timeline `:s/:f`.
7. Compute totals/attempts/accuracy.
8. Emit expanded JSON.

If implemented with the rules above, decompression is deterministic and lossless for all fields represented in your compressed formats.

Now that you understand how to uncompress the data using the field_mapping please only show the clean version inside the preview shown. Also please look at the teams and data tabs and make sure you adjust all of the data analysis tools inside of them to work with this new json. keep in mind that for data that has event time tracking enabled please store the json like this:

{
  "match": 6,
  "team": "2374",
  "scouter": "wdadw",

  "bricked": false,
  "slider": 50,

  "good": "thats rly good",
  "bad": "they suck",
  "area": "WOWO",

  "auto": {
    "outpost": {
      "total": 3,
      "attempts": 5,
      "successes": 3,
      "fails": 2,
      "accuracy": 0.6,
      "events": [
        { "time": 1.39, "value": 1, "result": "success" },
        { "time": 2.10, "value": 1, "result": "fail" },
        { "time": 2.65, "value": 1, "result": "fail" },
        { "time": 3.13, "value": 1, "result": "success" },
        { "time": 3.78, "value": 1, "result": "success" }
      ]
    },

    "fuel": {
      "total": 15,
      "events": [
        { "time": 5.15, "value": 3 },
        { "time": 5.30, "value": 3 },
        { "time": 5.45, "value": 3 },
        { "time": 5.60, "value": 3 },
        { "time": 5.74, "value": 3 }
      ]
    },

    "passing": {
      "total": 10,
      "events": [
        { "time": 8.61, "value": 10 }
      ]
    },

    "depot": {
      "total": 1,
      "events": [
        { "time": 9.34, "value": 1 }
      ]
    },

    "defense": {
      "totalTimeHeld": 0.69,
      "events": [
        { "time": 7.30, "duration": 0.69 }
      ]
    }
  },

  "teleop": {
    "l1": {
      "total": 1,
      "events": [
        { "time": 14.28, "value": 1 }
      ]
    },

    "fuel": {
      "total": 18,
      "events": [
        { "time": 16.07, "value": 3 },
        { "time": 16.22, "value": 3 },
        { "time": 16.36, "value": 3 },
        { "time": 16.52, "value": 3 },
        { "time": 16.65, "value": 3 },
        { "time": 16.79, "value": 3 }
      ]
    },

    "passing": {
      "total": 10,
      "events": [
        { "time": 19.23, "value": 10 }
      ]
    },

    "humanplayer": {
      "total": 1,
      "events": [
        { "time": 20.03, "value": 1 }
      ]
    },

    "defense": {
      "totalTimeHeld": 0.83,
      "events": [
        { "time": 18.32, "duration": 0.83 }
      ]
    }
  }
}


  and for data that does not have event time tracking it should look like this 

{
  "match": 4,
  "team": "5937",
  "scouter": "daw",

  "bricked": false,
  "slider": 50,

  "good": "good stuff",
  "bad": "bad stuff",
  "area": "idk bro",

  "auto": {
    "fuel": 24,

    "l1": { "total": 0 },
    "l3": { "total": 0 },

    "passing": {
      "total": 12
    },

    "defenseTimeHeld": 0,

    "outpost": {
      "total": 0,
      "attempts": 3,
      "successes": 2,
      "fails": 1,
      "accuracy": 0.67
    },

    "depot": { "total": 2 },
    "humanplayer": { "total": 0 }
  },

  "teleop": {
    "fuel": 33,

    "l1": { "total": 0 },
    "l3": { "total": 0 },

    "passing": {
      "total": 9
    },

    "defenseTimeHeld": 0,

    "outpost": {
      "total": 0,
      "attempts": 0,
      "successes": 0,
      "fails": 0,
      "accuracy": 0
    },

    "depot": { "total": 0 },
    "humanplayer": { "total": 1 }
  }
}




 you can find out what kind of format you need to use depending on the payload it will show you if it’s enabled or not ["enableEventTimeTracking":true]. please make sure that all the current metrics that have analysis are analyzed the same and accuracy with this new json. In addition let me give a suggestion for how to go about dealing with event time tracking jsons first go and add up all the increments to get the totals for each and then you can move on like normal. Also now that we have this new data, inside the data tab and the team’s analysis we don’t need to have the tags exact like auto.fuel and teleop.fuel instead just display fuel and have an option to switch between auto and teleop also account for this when picking x and y axis let the user also pick if they want it to be in auto or teleop. for example inside the data tab with the scatter and bar graphs, for the scatter plot when they click x axis and then click on fuel they should also be able to select auto or teleop this way they can plot auto.fuel on the x and teleop.fuel on the y make sure this still works with the change. also inside the data tab I currently have the y and y2 system but can you change it so that users can input as many as they want and also have a button that lets you set point values for example let’s say they click to display auto.fuel, teleop.fuel, teleop.climb you should be able to click on the set point values and assign different values or weights to each one which will reflect on the graph. Inside the teams tab when you click on a team it should give you an overview of all of their stats and if a metric has a success tracker on it it should also display the accuracy for that tag inside these stats and display accuracy with a pie chart if you can also do the same with toggle elements display a pie chart with how often this event happened as for held buttons display the average time per match here as well, in addition if you scroll down there should be boxes that show every match that the robot played in this should be in a clean box that can be scrolled through. when you click on a metric to see the match graph, let’s say you click fuel and then teleop, inside the graph if you click on a point/match it should then open up that match page this is a new thing that should be added, inside this match page you will be able to see the scouter name as well as an image of the field with the robots starting position please get this image from the backend in background_image in addition if event time tracking is enabled please use the payload information as well as the image to recreate the scouting viewer in a kind of mini view please look at this md to help understand how to recreate this 

# Mini Scout View Rendering Guide (Button-Only, No Functionality)

This guide shows exactly how to build a **mini scout renderer** that:

- draws the field image,
- places assets from payload coordinates correctly,
- scales correctly when the container resizes,
- renders only button-like assets,
- ignores covers, text fields, toggles, and user action buttons (`undo`, `redo`, `submit`, `reset`).

The implementation below is intentionally **render-only** (no click behavior/state logic).

---

## 1) Scope and Render Rules

### Included asset types

- `button` (except user action buttons)
- `icon-button`
- `button-slider` (rendered as a static button-style tile)

### Excluded asset types

- `cover`
- `text-input`
- `toggle-switch`
- `auto-toggle`
- `log-view`
- `team-select`
- `match-select`
- `slider`
- `start-position`
- `swap-sides`
- any unknown types

### Extra exclusion for user-action buttons

If a `button` has:

- `action` in `{undo, redo, submit, reset}`
- OR `text` in `{Undo, Redo, Submit, Reset}` (case-insensitive)

then skip rendering.

---

## 2) Coordinate System and Scaling

Payload uses normalized coordinate space:

- Position axes: $x, y \in [-100, 100]$
- Width/height are percentage-like values relative to field size.

### Convert payload position to percentages

$$x_{pct} = \frac{x + 100}{200} \cdot 100$$

$$y_{pct} = 100 - \left(\frac{y + 100}{200} \cdot 100\right)$$

The y expression flips vertical axis so top-left DOM origin aligns with scout coordinates.

### Convert to pixels inside field bounds

If `fieldBounds = { left, top, width, height }`:

$$left_{px} = left + width \cdot \frac{x_{pct}}{100}$$

$$top_{px} = top + height \cdot \frac{y_{pct}}{100}$$

$$width_{px} = width \cdot \frac{assetWidth}{100}$$

$$height_{px} = height \cdot \frac{assetHeight}{100}$$

Render each asset with `transform: translate(-50%, -50%)` so x/y stays center-based (matching editor behavior).

---

## 3) Why `getContainedBounds` is Required

The field image usually uses `object-fit: contain`. That means there may be letterboxing (empty side/top bars).

If you map coordinates against the full container instead of the **contained image rectangle**, assets drift off correct positions.

So compute:

1. container size
2. image natural size (or known aspect ratio)
3. contained rectangle (`left`, `top`, `width`, `height`)

Then place assets inside that rectangle.

---

## 4) Complete Mini Renderer Code

```tsx
"use client"

import { useEffect, useMemo, useRef, useState } from "react"

type CompactEntry = Record<string, Record<string, unknown>>

type MiniButtonAsset = {
  id: string
  kind: "button" | "icon-button" | "button-slider"
  x: number
  y: number
  width: number
  height: number
  text?: string
  icon?: string
  tag?: string
}

type BoxSize = { width: number; height: number }
type BoxBounds = { left: number; top: number; width: number; height: number }

type MiniScoutFieldProps = {
  payloadObject: unknown
  fieldImageUrl: string
  className?: string
}

const EXCLUDED_ACTIONS = new Set(["undo", "redo", "submit", "reset"])
const EXCLUDED_BUTTON_TEXT = new Set(["undo", "redo", "submit", "reset"])

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") return null
  return Number.isFinite(value) ? value : null
}

function clampPositionScale(value: number) {
  return Math.max(-100, Math.min(100, value))
}

function clampSizeScale(value: number) {
  return Math.max(0, Math.min(100, value))
}

function toPercentFromScale(value: number) {
  return ((value + 100) / 200) * 100
}

function getContainedBounds(containerSize: BoxSize, contentSize: BoxSize): BoxBounds {
  const { width: cw, height: ch } = containerSize
  const { width: iw, height: ih } = contentSize

  if (cw <= 0 || ch <= 0 || iw <= 0 || ih <= 0) {
    return { left: 0, top: 0, width: Math.max(0, cw), height: Math.max(0, ch) }
  }

  const scale = Math.min(cw / iw, ch / ih)
  const width = iw * scale
  const height = ih * scale

  return {
    left: (cw - width) / 2,
    top: (ch - height) / 2,
    width,
    height,
  }
}

function normalizeCompactPayloadItems(payloadEntries: unknown[]): Record<string, unknown>[] {
  return payloadEntries.reduce<Record<string, unknown>[]>((acc, entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return acc

    const sourceEntry = entry as CompactEntry
    const keys = Object.keys(sourceEntry)
    if (keys.length !== 1) return acc

    const sourceKind = keys[0]
    const sourceValue = sourceEntry[sourceKind]
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) return acc

    const source = sourceValue as Record<string, unknown>

    const left = toFiniteNumber(source.x1)
    const right = toFiniteNumber(source.x2)
    const top = toFiniteNumber(source.y1)
    const bottom = toFiniteNumber(source.y2)
    const hasBounds = left !== null && right !== null && top !== null && bottom !== null

    const x = toFiniteNumber(source.x) ?? (hasBounds ? ((left as number) + (right as number)) / 2 : null)
    const y = toFiniteNumber(source.y) ?? (hasBounds ? ((top as number) + (bottom as number)) / 2 : null)
    const width =
      toFiniteNumber(source.width) ?? (hasBounds ? Math.abs((right as number) - (left as number)) : null)
    const height =
      toFiniteNumber(source.height) ?? (hasBounds ? Math.abs((top as number) - (bottom as number)) : null)

    if (x === null || y === null || width === null || height === null) return acc

    const normalizedKind = sourceKind.trim().toLowerCase()
    const resolvedKind =
      normalizedKind === "icon-button"
        ? "icon-button"
        : normalizedKind === "button-slider"
          ? "button-slider"
          : normalizedKind

    acc.push({
      ...source,
      id:
        typeof source.id === "string" && source.id.trim().length > 0
          ? source.id.trim()
          : `${resolvedKind}-${index}`,
      type: resolvedKind,
      kind: resolvedKind,
      x,
      y,
      width,
      height,
      text:
        typeof source.text === "string"
          ? source.text
          : typeof source.label === "string"
            ? source.label
            : undefined,
      icon:
        typeof source.icon === "string"
          ? source.icon
          : typeof source.iconName === "string"
            ? source.iconName
            : undefined,
    })

    return acc
  }, [])
}

function getPayloadItems(payloadObject: unknown): Record<string, unknown>[] {
  if (!payloadObject || typeof payloadObject !== "object") return []

  const source = payloadObject as {
    payload?: unknown
    editorState?: { items?: unknown }
  }

  if (Array.isArray(source.payload)) {
    return normalizeCompactPayloadItems(source.payload)
  }

  if (Array.isArray(source.editorState?.items)) {
    return source.editorState.items.filter(
      (v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v))
    )
  }

  return []
}

function shouldSkipUserActionButton(item: Record<string, unknown>) {
  const action = typeof item.action === "string" ? item.action.trim().toLowerCase() : ""
  if (EXCLUDED_ACTIONS.has(action)) return true

  const text = typeof item.text === "string" ? item.text.trim().toLowerCase() : ""
  return EXCLUDED_BUTTON_TEXT.has(text)
}

function parseMiniAssets(payloadObject: unknown): MiniButtonAsset[] {
  const items = getPayloadItems(payloadObject)

  return items
    .filter((item) => {
      const type = typeof item.type === "string" ? item.type.toLowerCase() : ""
      const kind = typeof item.kind === "string" ? item.kind.toLowerCase() : ""
      const resolved = type || kind

      // Only render button-like assets.
      if (resolved !== "button" && resolved !== "icon-button" && resolved !== "button-slider") {
        return false
      }

      if (resolved === "button" && shouldSkipUserActionButton(item)) {
        return false
      }

      return true
    })
    .map((item, index) => {
      const type = (typeof item.type === "string" ? item.type.toLowerCase() : "") as
        | "button"
        | "icon-button"
        | "button-slider"

      return {
        id: typeof item.id === "string" && item.id.trim().length > 0 ? item.id : `asset-${index}`,
        kind: type,
        x: clampPositionScale(toFiniteNumber(item.x) ?? 0),
        y: clampPositionScale(toFiniteNumber(item.y) ?? 0),
        width: clampSizeScale(toFiniteNumber(item.width) ?? 0),
        height: clampSizeScale(toFiniteNumber(item.height) ?? 0),
        text:
          typeof item.text === "string"
            ? item.text
            : typeof item.label === "string"
              ? item.label
              : undefined,
        icon: typeof item.icon === "string" ? item.icon : typeof item.iconName === "string" ? item.iconName : undefined,
        tag: typeof item.tag === "string" ? item.tag : undefined,
      }
    })
}

function iconGlyph(iconName?: string) {
  if (!iconName) return "◯"
  const cleaned = iconName.replace(/icon$/i, "").replace(/[^a-zA-Z0-9]/g, "")
  const short = cleaned.slice(0, 2).toUpperCase()
  return short.length > 0 ? short : "◯"
}

export function MiniScoutField({ payloadObject, fieldImageUrl, className }: MiniScoutFieldProps) {
  const [containerSize, setContainerSize] = useState<BoxSize>({ width: 0, height: 0 })
  const [imageNaturalSize, setImageNaturalSize] = useState<BoxSize | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const assets = useMemo(() => parseMiniAssets(payloadObject), [payloadObject])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const update = () => {
      setContainerSize({ width: element.clientWidth, height: element.clientHeight })
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!fieldImageUrl) {
      setImageNaturalSize(null)
      return
    }

    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      setImageNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      if (cancelled) return
      setImageNaturalSize(null)
    }
    image.src = fieldImageUrl

    return () => {
      cancelled = true
    }
  }, [fieldImageUrl])

  const fieldBounds = useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return { left: 0, top: 0, width: 0, height: 0 }
    }

    if (!imageNaturalSize) {
      return {
        left: 0,
        top: 0,
        width: containerSize.width,
        height: containerSize.height,
      }
    }

    return getContainedBounds(containerSize, imageNaturalSize)
  }, [containerSize, imageNaturalSize])

  const getAssetStyle = (asset: MiniButtonAsset): React.CSSProperties => {
    const xPercent = toPercentFromScale(asset.x) / 100
    const yPercent = (100 - toPercentFromScale(asset.y)) / 100
    const widthPercent = asset.width / 100
    const heightPercent = asset.height / 100

    return {
      position: "absolute",
      left: fieldBounds.left + fieldBounds.width * xPercent,
      top: fieldBounds.top + fieldBounds.height * yPercent,
      width: Math.max(8, fieldBounds.width * widthPercent),
      height: Math.max(8, fieldBounds.height * heightPercent),
      transform: "translate(-50%, -50%)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.3)",
      background: "rgba(15, 23, 42, 0.92)",
      color: "white",
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1,
      pointerEvents: "none", // Render-only preview
      userSelect: "none",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      padding: "0 6px",
    }
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#020617",
        overflow: "hidden",
      }}
    >
      <img
        src={fieldImageUrl}
        alt="Field"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "center",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />

      {assets.map((asset) => {
        const label =
          asset.kind === "icon-button"
            ? iconGlyph(asset.icon)
            : asset.kind === "button-slider"
              ? asset.text || asset.tag || "Slider"
              : asset.text || asset.tag || "Button"

        return (
          <div key={asset.id} style={getAssetStyle(asset)} title={asset.tag || asset.text || asset.icon || asset.id}>
            {label}
          </div>
        )
      })}
    </div>
  )
}
```

---

## 5) How Rendering Works for Your Sample Payload

Given your sample payload, this renderer will:

1. Read `payload[]` compact entries (single-key objects like `{ "button": {...} }`).
2. Normalize each item into common shape (`type`, `x`, `y`, `width`, `height`, `text`, `icon`).
3. Keep only `button`, `icon-button`, `button-slider`.
4. Remove user-action buttons (`Submit`, `Reset`, `Undo`, `Redo`).
5. Ignore `cover`, `text-input`, `toggle-switch`, etc.
6. Measure visible image bounds inside container.
7. Convert each normalized coordinate to pixel position and size.
8. Draw all resulting assets as static overlays.

This means staged children like `+1`, `+3`, `+5`, `+10`, `L1`, `L2/3`, etc. all render as long as they are button-like assets.

---

## 6) Example Usage

```tsx
import { MiniScoutField } from "./MiniScoutField"

const payloadObject = YOUR_SAMPLE_PAYLOAD_OBJECT

export default function MiniPreviewPage() {
  return (
    <div style={{ width: "100%", height: "80vh" }}>
      <MiniScoutField
        payloadObject={payloadObject}
        fieldImageUrl="/fields/2026/your-field-image.png"
      />
    </div>
  )
}
```

---

## 7) Optional Tightening (If You Need It Later)

If you later want this mini view to mimic production visibility rules, add:

- stage-parent filtering,
- auto/teleop scope filtering,
- side-swapping reflection,
- true icon component mapping.

For your current goal (render-only, all button assets, no functionality), the code above is the simplest robust approach.



once you have this rendered the scout view please look at the json for this robot during this match and pull the tag of the button as well as the time each button was pressed using this information please clearly represent all the buttons the scouter clicked and allow the user to watch it almost like a view make it clear which buttons the scout is clicking and at what time. Inside this match view you will also be able to see the other robots that played in this match and when you click on them it will take you to their team analysis page also inside the team analysis page add another feature that lets you analyze cycle times this can only be done if event time tracking is enabled the user should be able to pick between two tag events let’s say teleop.noteintake and teleop.score and it will then calculate the average cycle time per match by looking at the json and seeing how much time is between those two events throughout the whole match and also allowing them to graph it just like other metrics. They should also be able to save this as a metric if they want to and make sure this is saved some place inside the root folder that is used as local storage make a new file called metrics or something like that.

next up inside the pick list tab please have a set of sliders for all tags and based on how you slide them it will impact how important each metric is, below the sliders should be a list of teams ranked from best at top to worst at bottom based off of these sliders and the weight that they have. Once you have configured your sliders you should be able to drag teams up or down depending on what you want to change and you should have the option to save a pick list and create a new one and also you should be able to cross/strike through teams by right clicking them to show that they have been selected furthermore clicking on a team in the pick list will bring you to their team page. id also like to add something new to the match page, you should be able to see notes taken down by the scouters this will be the text data that is collected by the scouters also if there are qualitative scouting data then show this as well in a separate box also add a find bar where you can search for key text words to see if it’s written. also inside of the teams page you should be able to scroll down and have a big text box that contains all the qualitative information on every match by both scouters and qualitative scouters although they should both be clearly distinguishable and this part should also have a search function where you can search for relevant text. 


Also lastly can you edit the #file:data.json and edit all of its values to create some moc data that I can use for testing please create one version with time analysis and another one without 

also if the user decides to upload their own file please be able to distingish between data with event time tracking on and off be able to tell the diference between the two json types without needing to use the payload information and adjust accordingly.
