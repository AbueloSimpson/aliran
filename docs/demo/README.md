# Demo assets

`epg.json` — an example of the program-guide feed format the platform consumes
(`catalog epgUrl`/`epgId` → `{channels:[{id, epg:[{title, start, stop}]}]}`, ISO
timestamps; see the SDK guide's EPG section). Used by the docs screenshots' local
demo stack; regenerate the timestamps if you reuse it (a guide that doesn't cover
"now" simply shows no program information).
