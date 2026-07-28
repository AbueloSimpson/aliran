# Demo assets

`channels.json` — an example of the **source feed**. A panel imports this file as
a category of redirect channels (Sources tab → Add source). It shows the two
required fields (`id` and `url`) and the three optional fields (`name`, `logo`
and `description`). It also shows an entry with the required fields only, and an
`epg` array that the panel leaves in the file. For the field rules and the sync
policy, see
[Content Management](../content-management.md#remote-channel-sources-provider-feeds).

`epg.json` — an example of the program-guide feed format the platform consumes
(`catalog epgUrl`/`epgId` → `{channels:[{id, epg:[{title, start, stop}]}]}`, ISO
timestamps; see the SDK guide's EPG section). Used by the docs screenshots' local
demo stack; regenerate the timestamps if you reuse it (a guide that doesn't cover
"now" simply shows no program information).
