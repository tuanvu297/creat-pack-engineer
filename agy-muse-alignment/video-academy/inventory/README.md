# Inventory scope

skill-catalog.json exports readable installed skill names/descriptions and source-relative locations only. It does not copy provider credentials or imply that a skill's tools exist in Muse. Duplicate versions are retained with their source paths so an executor can choose the current appropriate package.

tool-catalog.json lists tool names exposed to this control-plane session. Availability to ChatGPT is not a Muse permission grant. Refresh the actual Muse tool/connector inventory before execution; use each provider's supported account consent.
