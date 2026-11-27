# Zulrah (work in progress)

Zulrah at Zul-Andra: all four rotations, the serpentine (green), magma (red) and tanzanite (blue)
forms, the jad phase, the tail stare and stun, venom clouds, snakelings, venom and the 45–50 damage
cap. Practice controls pin a rotation (Random or 1–4) and toggle each mechanic.

- Sourced facts: [facts spec](../../../docs/encounters/zulrah-facts-spec.md). The facts measured in
  the private gameplay captures zulrah-packet-data-1.txt to zulrah-packet-data-4.txt are pinned in
  [`__tests__/fixtures/zulrahCapture.ts`](./__tests__/fixtures/zulrahCapture.ts);
  [`__tests__/zulrahArenaSight.test.ts`](./__tests__/zulrahArenaSight.test.ts) checks their
  line-of-sight tiles against the pinned cache's arena when `npm run setup` has fetched it.
- Decisions past the evidence: [policy](../../../docs/encounters/zulrah-policy.md).
- Unsettled behavior and what would settle it: [open questions](../../../docs/encounters/zulrah-open-questions.md).

Not simulated: the random out-of-pattern phases the wiki describes after the first rotation.

## Code map

| File | Role |
|---|---|
| [`ZulrahEncounter.ts`](./ZulrahEncounter.ts) | Phase machine (emerge, active, dive, next form), opening, clouds, snakeling landings, outcome |
| [`rotation.ts`](./rotation.ts) | The four rotation tables, spot tiles, rotation stepping and form-change timing |
| [`clouds.ts`](./clouds.ts) | Cloud sites, fill order and site selection |
| [`controls.ts`](./controls.ts) | Rotation choice and mechanic toggles |
| [`renderConfig.ts`](./renderConfig.ts), [`ZulrahSceneObjectController.ts`](./ZulrahSceneObjectController.ts) | Form clips and the cloud locs, drawn by the Inferno compositor (`render/scene/zulrahSceneBuilder.ts`) |
| [`../../npcs/zulrah/zulrah.ts`](../../npcs/zulrah/zulrah.ts) | The Zulrah actor: attack queue and its line-of-sight wait, tail, cloud and snakeling spits, transformation |
| [`../../npcs/zulrah/snakeling.ts`](../../npcs/zulrah/snakeling.ts) | Snakeling definition |
| [`../../npcs/zulrah/constants.ts`](../../npcs/zulrah/constants.ts) | Ids and mechanic constants, each with its source |

Shared engine support it relies on: tiles past one map square (`isInTileSpace`), hidden NPCs
(`NpcActor.hidden`), a per-NPC hit cap (`incomingHitCap`), the `playerStunned` engine rule, and
venom-immune helms (`data/venomImmunity.ts`).
