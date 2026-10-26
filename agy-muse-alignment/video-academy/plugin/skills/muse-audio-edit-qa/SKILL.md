---
name: muse-audio-edit-qa
description: "Assemble and verify AGY video edits, Vietnamese narration, sound and exported media, including invisible joins and identity continuity. Use for actual media QA; metadata-only checks cannot establish perceptual PASS."
---

# Audio, edit and export QA

Read ../../knowledge/03-audio-edit-delivery.md and ../../knowledge/04-artifact-qa.md. Preserve accepted shots and voice identity. Edit with source-backed timing, motivated cuts, controlled continuity and a complete dialogue/ambience/music/SFX plan.

For a recurring Vietnamese narrator, compare different actual voice IDs with the same text, level-match auditions and listen to the whole passage. Check tones/names/consonants, natural phrasing, complete words and identity. Do not silently replace the approved speaker or clone a real person without authority.

Inspect joins in normal-speed playback and around the boundary frame by frame. Check position, face/body/wardrobe, gaze/action direction, light/color, object contact, audio phase/level, room tone and cut syllables. A crossfade can hide a boundary while introducing a double image; verify the actual result.

Technical checks cover decodability, duration, streams, codec, dimensions, fps, hash and missing/corrupt sections. Perceptual checks cover full motion, all audio and story pacing; a transcript, image sample or ffprobe result does not prove them. When listening or viewing is unavailable, retain UNVERIFIED for that check. Return defect timecodes and repair only failed variables.

