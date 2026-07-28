# Demo assets

`channels.json` — an example of the **source feed** a panel imports as a category
of redirect channels (Sources tab → Add source). It shows the two required fields
(`id`, `url`), the optional ones (`name`, `logo`, `description`), an entry that
carries only the required pair, and an `epg` array the panel leaves in the file.
See [Content Management](../content-management.md#remote-channel-sources-provider-feeds)
for the field rules and the sync policy.

`epg.json` — an example of the program-guide feed format the platform consumes
(`catalog epgUrl`/`epgId` → `{channels:[{id, epg:[{title, start, stop}]}]}`, ISO
timestamps; see the SDK guide's EPG section). Used by the docs screenshots' local
demo stack; regenerate the timestamps if you reuse it (a guide that doesn't cover
"now" simply shows no program information).
