/**
 * Attribution for third-party material that npm metadata cannot find.
 *
 * `collectPackageNotices` in [licenseNotices.ts](./licenseNotices.ts) walks the
 * production dependency graph, so anything installed from a registry already
 * carries its own license file. The entries here are the things that walk
 * cannot see: code ported into `src/` by hand, the C libraries and toolchain
 * runtime compiled into the committed `.wasm` and its loader, the OSRS
 * Wiki-derived data, and the statement covering the Jagex content a build made
 * after `npm run setup` contains.
 *
 * Every `text` is the license VERBATIM as its upstream publishes it. BSD-2
 * clause 2 requires binary distributions reproduce the notice, conditions and
 * disclaimer, so reflowing or trimming one of these to fit a line width is the
 * edit that breaks the obligation this file exists to satisfy.
 */

export interface VendoredNotice {
  /** The upstream work being attributed. */
  readonly component: string;
  /** Where the upstream work lives, for a reader who wants to check it. */
  readonly source: string;
  /** SPDX identifier, or a short name where the terms have no SPDX id. */
  readonly license: string;
  /**
   * The license this project takes where `license` offers a choice (`MIT OR NCSA`). The policy gate
   * rejects an un-elected choice, as it does for npm packages.
   */
  readonly elected?: string;
  /**
   * Our paths the notice covers — the evidence for why the entry is here, and
   * build-time only: `renderVendored` never puts it in `licenses.txt`. No
   * permissive license asks a redistributor to identify which of its own files
   * are derived, and shipping the list points a reader at a `src/` tree that is
   * not in the distribution they downloaded. Anything a license genuinely
   * requires the reader to see goes in `attribution` instead.
   */
  readonly applies: readonly string[];
  /**
   * Lines the shipped notice must carry beyond the license text itself.
   *
   * Reserved for terms that reach past "reproduce the notice": Creative Commons
   * attribution has to identify the material used and flag that it was adapted
   * (CC BY-NC-SA 3.0 §4(c)), and an upstream crediting its own contributors
   * passes that credit on to us. Leave it undefined wherever `component`,
   * `source` and `text` already say everything the license demands — padding
   * every entry with a scope blurb buries the one that carries an obligation.
   */
  readonly attribution?: readonly string[];
  /**
   * Verbatim license text, or the canonical URI where the terms only require a
   * link. The Creative Commons license is satisfied by the URI (CC BY-NC-SA 3.0
   * §4(c)); the BSD and bzip2 terms are not.
   */
  readonly text: string;
}

const BSD_2_CLAUSE_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/**
 * The RuneLite revision the per-file headers below were read at. Every header there is identical to
 * the one at the revision each file was ported from, except FacePrioritySorter.java, which is gone
 * by then (see its entry).
 */
const RUNELITE_REVISION = 'ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2';

/**
 * The license text RuneLite's source files carry in their own headers. It differs from the
 * repository LICENSE in layout (numbered clauses, "COPYRIGHT OWNER"), and each file names its own
 * holders, so a ported file is attributed with its header rather than with the repository's.
 */
const RUNELITE_FILE_HEADER_BODY = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/** A RuneLite file header, comment markers removed: its copyright lines, then the shared terms. */
function runeliteFileNotice(copyrightLines: string): string {
  return `${copyrightLines}\nAll rights reserved.\n\n${RUNELITE_FILE_HEADER_BODY}`;
}

export const VENDORED_NOTICES: readonly VendoredNotice[] = [
  {
    component: 'RSMod NPC combat',
    source: 'https://github.com/rsmod/rsmod/tree/fa13b3f67172ef36e15d6b1514358aee61411796',
    license: 'ISC',
    applies: [
      'src/core/combat/flinch.ts — independently implemented NPC retaliation semantics',
      'src/core/combat/retaliation.ts',
      'src/core/combat/npcActionClock.ts',
      'src/core/npcCombatMovement.ts — default hostile NPC pursuit and footprint contact destination',
      'src/core/npcOccupancy.ts — leading-edge actor collision for default pursuit',
      'src/core/combat/npcAttackRequest.ts — shared NPC approach reach and reverse line of sight',
      'src/core/SimulationEngine.ts — independently implemented player teleport and action-lock semantics',
    ],
    text: `Copyright (c) 2025 RS Mod

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`,
  },
  {
    component: '2004Scape NPC combat',
    source: 'https://github.com/2004Scape/Server/tree/647886c42f8a22c0f18e5dbe79c2697f052f8d2e',
    license: 'MIT',
    applies: [
      'src/core/combat/flinch.ts — independently implemented NPC retaliation semantics',
      'src/core/combat/retaliation.ts',
      'src/core/combat/npcActionClock.ts',
      'src/core/npcCombatMovement.ts — pursuit remains independent of the ordinary attack action delay',
    ],
    text: `MIT License

Copyright (c) 2023-2025 Lost City

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },
  {
    component: 'RSMOD RouteFinding',
    source: 'https://github.com/rsmod/rsmod/tree/fa13b3f67172ef36e15d6b1514358aee61411796/engine/routefinder',
    license: 'ISC',
    applies: ['src/core/npcRouteFinding.ts — independently simplified TypeScript port for NPC melee pursuit'],
    text: `Copyright (c) 2025 RS Mod

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  },
  {
    component: 'rs-map-viewer',
    // The last upstream commit before the first port. Its LICENSE is unchanged since 2023-11-16,
    // and none of the ported files carries a header of its own.
    source: 'https://github.com/dennisdev/rs-map-viewer/tree/ce2278728ba4b7c9155ac9cf7c936438eef11ad0',
    license: 'BSD-2-Clause',
    applies: [
      'src/rs/** — the OSRS cache, model, animation, map and sprite decoders are ported from this project',
      'src/render/backends/picogl/PicoTexture.ts',
      'src/render/backends/picogl/LocAnimated.ts',
      'src/render/backends/picogl/TerrainBuilder.ts',
      'src/render/components/RenderViewport3D.tsx — camera setup',
    ],
    text: `BSD 2-Clause License

Copyright (c) 2022-2023, dennisdev
All rights reserved.

${BSD_2_CLAUSE_BODY}`,
  },
  {
    component: 'RuneLite',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/rs/model/textureUv.ts — ModelDefinition.java, which carries no header of its own',
      'src/data/weaponCombatVisuals.generated.ts — projectile ids named from the generated gameval SpotanimID.java (no header)',
      'public/assets/ui/healthbar/default_*.png — not committed; `npm run setup` downloads them from runelite-client/src/main/resources/net/runelite/client/plugins/interfacestyles/2010/healthbar/ at commit ae11244136b396dcbf976b38974a3877bbe62cd6 (scripts/assets/runeliteHealthbars.ts)',
      'public/assets/ui/healthbar/dark_back_*.png and yellow_front_*.png — recolored from those by the same script',
      'Everything in the RuneLite file entries below, which RuneLite distributes under this license too',
    ],
    attribution: [
      'The repository license. Files ported from RuneLite that carry their own copyright',
      'header are listed separately below, each with that header.',
    ],
    text: `BSD 2-Clause License

Copyright (c) 2016-2017, Adam <Adam@sigterm.info>
All rights reserved.

${BSD_2_CLAUSE_BODY}`,
  },
  {
    component: 'RuneLite: Perspective.java and PrayerFlickOverlay.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/render/projections/Projection3D.ts — ported from Perspective.java',
      'src/render/scene/npcPick.ts — ported from Perspective.getClickbox / calculate2DBounds',
      'src/components/prayerFlickOrb.ts — ported from PrayerFlickOverlay.java',
    ],
    text: runeliteFileNotice('Copyright (c) 2017, Adam <Adam@sigterm.info>'),
  },
  {
    component:
      'RuneLite: FacePrioritySorter.java, GpuPlugin.java, SceneUploader.java, and the GPU plugin vert.glsl and frag.glsl',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/render/core/FacePrioritySorter.ts — FacePrioritySorter.java',
      'src/render/core/splitMeshByAlpha.ts — FacePrioritySorter.java',
      'src/render/backends/picogl/PicoGLRenderer.ts — GpuPlugin.java blend and sort semantics',
      'src/render/backends/picogl/shaders/*.glsl — texture animation and alpha semantics from vert.glsl, frag.glsl and GpuPlugin.java',
      'src/rs/model/textureUv.ts — SceneUploader.computeFaceUvs',
    ],
    // FacePrioritySorter.java does not exist at RUNELITE_REVISION: RuneLite renamed it to
    // ModelUploader.java in 439fc3351e1a71d038a80b17cd5d8c7be0156bea (2026-07-16), after the port.
    attribution: [
      'FacePrioritySorter.java as at RuneLite 938f61e2890767b48481e382251edd57cf1d446f,',
      'the revision current when it was ported.',
    ],
    text: runeliteFileNotice('Copyright (c) 2018, Adam <Adam@sigterm.info>'),
  },
  {
    component: 'RuneLite: IntProjection.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/render/core/FacePrioritySorter.ts — the IntProjection.project() camera projection'],
    text: runeliteFileNotice('Copyright (c) 2024, Adam <Adam@sigterm.info>'),
  },
  {
    component: 'RuneLite: WorldArea.java, CollisionDataFlag.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/core/combat/distance.ts — ported from WorldArea.hasLineOfSight, with CollisionDataFlag.java',
      'src/rs/collision/CollisionFlag.ts — the CollisionDataFlag.java line-of-sight flags',
    ],
    text: runeliteFileNotice('Copyright (c) 2018, Woox <https://github.com/wooxsolo>'),
  },
  {
    component: 'RuneLite: PrayerPlugin.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/components/prayerFlickOrb.ts — the flick-helper timing from PrayerPlugin.java'],
    text: runeliteFileNotice(
      'Copyright (c) 2017, Adam <Adam@sigterm.info>\nCopyright (c) 2018, Raqes <j.raqes@gmail.com>',
    ),
  },
  {
    component: 'RuneLite: PrayerConfig.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/components/prayerFlickOrb.ts — the "Never hide prayer flick helper" option from PrayerConfig.java'],
    text: runeliteFileNotice('Copyright (c) 2018, Raqes <j.raqes@gmail.com>'),
  },
  {
    component: 'RuneLite: CameraPlugin.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/render/projections/Projection3D.ts — the zoom-limit rules from CameraPlugin.applyConfigs'],
    text: runeliteFileNotice(
      'Copyright (c) 2018 Abex\nCopyright (c) 2018, Adam <Adam@sigterm.info>\nCopyright (c) 2019, Wynadorn <https://github.com/Wynadorn>',
    ),
  },
  {
    component: 'RuneLite: CameraConfig.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/render/projections/Projection3D.ts — the inner and outer zoom-limit options from CameraConfig.java'],
    text: runeliteFileNotice('Copyright (c) 2018 Abex'),
  },
  {
    component: 'RuneLite: StatusBarsOverlay.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/components/GamePanel/StatusBars.tsx — the bar placement, heights and icon centering from StatusBarsOverlay.java',
      'src/components/GamePanel/statusBarsPaint.ts — the default bar colors from StatusBarsOverlay.java',
    ],
    text: runeliteFileNotice(
      'Copyright (c) 2019, Jos <Malevolentdev@gmail.com>\nCopyright (c) 2019, Rheon <https://github.com/Rheon-D>',
    ),
  },
  {
    component: 'RuneLite: BarRenderer.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: [
      'src/components/GamePanel/statusBarsPaint.ts — the border, background, fill height and icon inset from BarRenderer.java',
      'src/components/GamePanel/StatusBars.tsx — the default bar width from BarRenderer.java',
    ],
    // Same holders as StatusBarsOverlay.java, but this header wraps its disclaimer differently and
    // says "COPYRIGHT HOLDER", so it is reproduced as written rather than through runeliteFileNotice.
    text: `Copyright (c) 2019, Jos <Malevolentdev@gmail.com>
Copyright (c) 2019, Rheon <https://github.com/Rheon-D>
All rights reserved.

${RUNELITE_FILE_HEADER_BODY.slice(0, RUNELITE_FILE_HEADER_BODY.indexOf('THIS SOFTWARE IS PROVIDED'))}${BSD_2_CLAUSE_BODY.slice(BSD_2_CLAUSE_BODY.indexOf('THIS SOFTWARE IS PROVIDED'))}`,
  },
  {
    component: 'RuneLite: Viewport.java (Status Bars)',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/components/GamePanel/StatusBars.tsx — the per-layout bar offsets from the statusbars Viewport.java'],
    text: runeliteFileNotice('Copyright (c) 2018, Jos <Malevolentdev@gmail.com>'),
  },
  {
    component: 'RuneLite: StatusBarsConfig.java',
    source: `https://github.com/runelite/runelite/tree/${RUNELITE_REVISION}`,
    license: 'BSD-2-Clause',
    applies: ['src/components/GamePanel/StatusBars.tsx — the default bar width option from StatusBarsConfig.java'],
    text: runeliteFileNotice('Copyright (c) 2019, Jos <Malevolentdev@gmail.com>'),
  },
  {
    component: 'Compact Orbs, by cue (its-cue)',
    // The last upstream commit before src/types/compactOrbs.ts was written.
    source: 'https://github.com/its-cue/compact-orbs/tree/fd3678bc9ef569b5912bb707cfe1c38e012f2f0c',
    license: 'BSD-2-Clause',
    applies: [
      'src/types/compactOrbs.ts — the layout options (vertical, horizontal, horizontal-wide) from CompactOrbsLayout.java',
      "src/components/minimapOrbGeometry.ts — the plugin's column-major slot order (its widget/layout/slot classes)",
    ],
    attribution: [
      'The header its source files carry, CompactOrbsLayout.java and the slot layout',
      'classes included, then the repository LICENSE.',
    ],
    // The file header's terms are word for word those RuneLite's file headers carry.
    text: `Copyright (c) 2025, cue <https://github.com/its-cue>
All rights reserved.

${RUNELITE_FILE_HEADER_BODY}

---

BSD 2-Clause License

Copyright (c) 2025, its-cue

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

${BSD_2_CLAUSE_BODY.slice(BSD_2_CLAUSE_BODY.indexOf('THIS SOFTWARE IS PROVIDED'))}`,
  },
  {
    component: 'Weapon Animation Replacer, by geheur',
    source: 'https://github.com/geheur/weapon-animation-replacer/tree/0312d8c5b9738b9774e8c7101c1ca1a2d1c1eaaf',
    license: 'BSD-2-Clause',
    applies: [
      'src/data/weaponCombatVisuals.generated.ts — animation sets and projectiles generated from its data.json',
    ],
    text: `BSD 2-Clause License

Copyright (c) 2021, geheur
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

${BSD_2_CLAUSE_BODY.slice(BSD_2_CLAUSE_BODY.indexOf('THIS SOFTWARE IS PROVIDED'))}`,
  },
  {
    component: 'PlayerAttackAnimations.java, in kotori-plugins',
    // The tree rather than the file URL: the rendered notices must not contain a `src/` path.
    source: 'https://github.com/OreoCupcakes/kotori-plugins/tree/0e7c60f6dac45e6a68e673a45950c06c5891f393',
    license: 'BSD-2-Clause',
    applies: ['src/data/weaponCombatVisuals.generated.ts — the attack-animation names table'],
    // The file carries its own authors' notice, which is what it is redistributed under.
    text: `Copyright (c) 2021, Matsyir <https://github.com/matsyir>
Copyright (c) 2020, Mazhar <https://twitter.com/maz_rs>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
  {
    component: 'Tile Packs, by TrevorMDev',
    source: 'https://github.com/TrevorMDev/tile-packs/tree/fa48c15408c9dc86f1739c8d6def18d7a2fb19a6',
    license: 'BSD-2-Clause',
    applies: ['src/data/tilePackPresets.ts — the "Yama No Fly" pack (id 66 in its tilePacks.jsonc), recolored'],
    text: `BSD 2-Clause License

Copyright (c) 2022, TrevorMDev
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

${BSD_2_CLAUSE_BODY.slice(BSD_2_CLAUSE_BODY.indexOf('THIS SOFTWARE IS PROVIDED'))}`,
  },
  {
    component: 'RuneMarkers, by Jamie Young',
    source: 'https://github.com/jamiegyoung/runemarkers/tree/b6fb9d0b3aa5706662267c2bdf0b00d4113dd158',
    license: 'MIT',
    applies: [
      'src/data/tilePackPresets.ts — the Zuk Inferno pack, from its entities/inferno.json (We Do Raids tiles), recolored',
    ],
    // RuneMarkers credits the tiles to the We Do Raids community's `!infernotiles` command,
    // and its UNSAFE label to Brew Time; passed on here as its own attribution.
    attribution: [
      "Tiles credited by RuneMarkers to the We Do Raids community's !infernotiles command,",
      'with the UNSAFE label courtesy of Brew Time.',
    ],
    text: `MIT License

Copyright (c) 2024 Jamie Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
  {
    component: 'Mulberry32, by Tommy Ettinger, in the JavaScript form of bryc/code PRNGs.md',
    // PRNGs.md as at this commit; the algorithm is Ettinger's 2017 mulberry32.c gist, whose header is
    // the CC0 dedication quoted below.
    source: 'https://github.com/bryc/code/blob/88c1317ea6f9b25c153afa9c369c365fed11b482/jshash/PRNGs.md#mulberry32',
    license: 'Public domain',
    applies: ['src/core/rng.ts — mulberry32()'],
    text: `PRNGs.md: "License: Public domain."

mulberry32.c (https://gist.github.com/tommyettinger/46a874533244883189143505d203312c):

Written in 2017 by Tommy Ettinger (tommy.ettinger@gmail.com)

To the extent possible under law, the author has dedicated all copyright
and related and neighboring rights to this software to the public domain
worldwide. This software is distributed without any warranty.

See <http://creativecommons.org/publicdomain/zero/1.0/>.`,
  },
  {
    component: 'bzip2 / libbzip2',
    source: 'https://sourceware.org/bzip2/',
    license: 'bzip2-1.0.6',
    applies: [
      'bzip2.wasm and bzip2-module.js — libbzip2 compiled to WebAssembly and redistributed via @foxglove/wasm-bz2, whose own MIT license covers only the wrapper',
    ],
    text: `--------------------------------------------------------------------------

This program, "bzip2", the associated library "libbzip2", and all
documentation, are copyright (C) 1996-2010 Julian R Seward.  All
rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. The origin of this software must not be misrepresented; you must 
   not claim that you wrote the original software.  If you use this 
   software in a product, an acknowledgment in the product 
   documentation would be appreciated but is not required.

3. Altered source versions must be plainly marked as such, and must
   not be misrepresented as being the original software.

4. The name of the author may not be used to endorse or promote 
   products derived from this software without specific prior written 
   permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR \`\`AS IS'' AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Julian Seward, jseward@acm.org
bzip2/libbzip2 version 1.0.6 of 6 September 2010

--------------------------------------------------------------------------`,
  },
  {
    component: '@foxglove/wasm-bz2 0.3.0: bzip2.wasm and bzip2-module.js',
    // The committed binaries are this package's wasm/module.wasm and wasm/module.js, byte for byte.
    // Its notice is also printed under NPM PACKAGES; it is repeated here so the binaries' attribution
    // does not depend on the package staying in `dependencies`.
    source: 'https://github.com/foxglove/wasm-bz2/tree/eb3258759fb18d6c9e018708414cb9858cead601',
    license: 'MIT',
    applies: ['public/bzip2.wasm, public/bzip2-module.js — wasm/module.wasm and wasm/module.js, unchanged'],
    text: `MIT License

Copyright (c) Foxglove Technologies Inc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
  {
    component: 'Emscripten 3.1.26: the runtime in bzip2.wasm and the generated bzip2-module.js loader',
    // wasm-bz2 v0.3.0's build.sh builds with the emscripten/emsdk:3.1.26 image.
    source: 'https://github.com/emscripten-core/emscripten/tree/3.1.26',
    license: 'MIT OR NCSA',
    elected: 'MIT',
    applies: [
      'public/bzip2-module.js — Emscripten-generated JavaScript glue',
      'public/bzip2.wasm — Emscripten system libraries (embind, dlmalloc, syscall stubs) linked into the module',
    ],
    text: `Emscripten is available under 2 licenses, the MIT license and the
University of Illinois/NCSA Open Source License.

Both are permissive open source licenses, with little if any
practical difference between them.

The reason for offering both is that (1) the MIT license is
well-known, while (2) the University of Illinois/NCSA Open Source
License allows Emscripten's code to be integrated upstream into
LLVM, which uses that license, should the opportunity arise.

The full text of both licenses follows.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal with the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimers.

    Redistributions in binary form must reproduce the above
    copyright notice, this list of conditions and the following disclaimers
    in the documentation and/or other materials provided with the
    distribution.

    Neither the names of Mozilla,
    nor the names of its contributors may be used to endorse
    or promote products derived from this Software without specific prior
    written permission. 

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE SOFTWARE.

==============================================================================

This program uses portions of Node.js source code located in src/library_path.js,
in accordance with the terms of the MIT license. Node's license follows:

    """
        Copyright Joyent, Inc. and other Node contributors. All rights reserved.
        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to
        deal in the Software without restriction, including without limitation the
        rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
        sell copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:

        The above copyright notice and this permission notice shall be included in
        all copies or substantial portions of the Software.

        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
        FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
        IN THE SOFTWARE.
    """

The musl libc project is bundled in this repo, and it has the MIT license, see
system/lib/libc/musl/COPYRIGHT

The third_party/ subdirectory contains code with other licenses. None of it is
used by default, but certain options use it (e.g., the optional closure compiler
flag will run closure compiler from third_party/).`,
  },
  {
    component: 'musl libc, as bundled in Emscripten 3.1.26',
    source: 'https://github.com/emscripten-core/emscripten/tree/3.1.26/system/lib/libc/musl',
    license: 'MIT',
    applies: ['public/bzip2.wasm — the musl stdio, string, math and ctype routines linked into the module'],
    text: `musl as a whole is licensed under the following standard MIT license:

----------------------------------------------------------------------
Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
----------------------------------------------------------------------

Authors/contributors include:

A. Wilcox
Ada Worcester
Alex Dowad
Alex Suykov
Alexander Monakov
Andre McCurdy
Andrew Kelley
Anthony G. Basile
Aric Belsito
Arvid Picciani
Bartosz Brachaczek
Benjamin Peterson
Bobby Bingham
Boris Brezillon
Brent Cook
Chris Spiegel
Clément Vasseur
Daniel Micay
Daniel Sabogal
Daurnimator
David Carlier
David Edelsohn
Denys Vlasenko
Dmitry Ivanov
Dmitry V. Levin
Drew DeVault
Emil Renner Berthing
Fangrui Song
Felix Fietkau
Felix Janda
Gianluca Anzolin
Hauke Mehrtens
He X
Hiltjo Posthuma
Isaac Dunham
Jaydeep Patil
Jens Gustedt
Jeremy Huntwork
Jo-Philipp Wich
Joakim Sindholt
John Spencer
Julien Ramseier
Justin Cormack
Kaarle Ritvanen
Khem Raj
Kylie McClain
Leah Neukirchen
Luca Barbato
Luka Perkov
M Farkas-Dyck (Strake)
Mahesh Bodapati
Markus Wichmann
Masanori Ogino
Michael Clark
Michael Forney
Mikhail Kremnyov
Natanael Copa
Nicholas J. Kain
orc
Pascal Cuoq
Patrick Oppenlander
Petr Hosek
Petr Skocik
Pierre Carrier
Reini Urban
Rich Felker
Richard Pennington
Ryan Fairfax
Samuel Holland
Segev Finer
Shiz
sin
Solar Designer
Stefan Kristiansson
Stefan O'Rear
Szabolcs Nagy
Timo Teräs
Trutz Behn
Valentin Ochs
Will Dietz
William Haddon
William Pitcock

Portions of this software are derived from third-party works licensed
under terms compatible with the above MIT license:

The TRE regular expression implementation (src/regex/reg* and
src/regex/tre*) is Copyright © 2001-2008 Ville Laurikari and licensed
under a 2-clause BSD license (license text in the source files). The
included version has been heavily modified by Rich Felker in 2012, in
the interests of size, simplicity, and namespace cleanliness.

Much of the math library code (src/math/* and src/complex/*) is
Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or
Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or
Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited
and labelled as such in comments in the individual source files. All
have been licensed under extremely permissive terms.

The ARM memcpy code (src/string/arm/memcpy.S) is Copyright © 2008
The Android Open Source Project and is licensed under a two-clause BSD
license. It was taken from Bionic libc, used on Android.

The AArch64 memcpy and memset code (src/string/aarch64/*) are
Copyright © 1999-2019, Arm Limited.

The implementation of DES for crypt (src/crypt/crypt_des.c) is
Copyright © 1994 David Burren. It is licensed under a BSD license.

The implementation of blowfish crypt (src/crypt/crypt_blowfish.c) was
originally written by Solar Designer and placed into the public
domain. The code also comes with a fallback permissive license for use
in jurisdictions that may not recognize the public domain.

The smoothsort implementation (src/stdlib/qsort.c) is Copyright © 2011
Valentin Ochs and is licensed under an MIT-style license.

The x86_64 port was written by Nicholas J. Kain and is licensed under
the standard MIT terms.

The mips and microblaze ports were originally written by Richard
Pennington for use in the ellcc project. The original code was adapted
by Rich Felker for build system and code conventions during upstream
integration. It is licensed under the standard MIT terms.

The mips64 port was contributed by Imagination Technologies and is
licensed under the standard MIT terms.

The powerpc port was also originally written by Richard Pennington,
and later supplemented and integrated by John Spencer. It is licensed
under the standard MIT terms.

All other files which have no copyright comments are original works
produced specifically for use as part of this library, written either
by Rich Felker, the main author of the library, or by one or more
contibutors listed above. Details on authorship of individual files
can be found in the git version control history of the project. The
omission of copyright and license comments in each file is in the
interest of source tree size.

In addition, permission is hereby granted for all public header files
(include/* and arch/*/bits/*) and crt files intended to be linked into
applications (crt/*, ldso/dlstart.c, and arch/*/crt_arch.h) to omit
the copyright notice and permission notice otherwise required by the
license, and to use these files without any requirement of
attribution. These files include substantial contributions from:

Bobby Bingham
John Spencer
Nicholas J. Kain
Rich Felker
Richard Pennington
Stefan Kristiansson
Szabolcs Nagy

all of whom have explicitly granted such permission.

This file previously contained text expressing a belief that most of
the files covered by the above exception were sufficiently trivial not
to be subject to copyright, resulting in confusion over whether it
negated the permissions granted in the license. In the spirit of
permissive licensing, and of not having licensing issues being an
obstacle to adoption, that text has been removed.`,
  },
  {
    component: 'LLVM runtime libraries (compiler-rt, libc++, libc++abi), as bundled in Emscripten 3.1.26',
    source: 'https://github.com/emscripten-core/emscripten/tree/3.1.26/system/lib',
    license: 'Apache-2.0 WITH LLVM-exception',
    applies: [
      'public/bzip2.wasm — compiler-rt builtins (128-bit float and integer helpers), libc++ and the libc++abi demangler, linked into the module',
    ],
    // The LLVM exception waives the notice conditions for these libraries' compiled object code, so
    // this entry is a courtesy for the Apache-2.0 terms. It is kept because the file also carries the
    // legacy NCSA and MIT terms, which have no such exception.
    attribution: [
      "This is libc++abi's LICENSE.TXT. compiler-rt's and libc++'s at the same revision",
      'are identical except that the legacy paragraph names their own library, and',
      'compiler-rt\'s MIT notice reads "Copyright (c) 2009-2015 by the contributors',
      'listed in CREDITS.TXT".',
    ],
    text: `==============================================================================
The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:
==============================================================================

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

    2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

    3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

    4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

    5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

    6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

    7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

    8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

    9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

    END OF TERMS AND CONDITIONS

    APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

    Copyright [yyyy] [name of copyright owner]

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.

==============================================================================
Software from third parties included in the LLVM Project:
==============================================================================
The LLVM Project contains third party software which is under different license
terms. All such code will be identified clearly using at least one of two
mechanisms:
1) It will be in a separate directory tree with its own \`LICENSE.txt\` or
   \`LICENSE\` file at the top containing the specific license and restrictions
   which apply to that software, or
2) It will contain specific license and restriction terms at the top of every
   file.

==============================================================================
Legacy LLVM License (https://llvm.org/docs/DeveloperPolicy.html#legacy):
==============================================================================

The libc++abi library is dual licensed under both the University of Illinois
"BSD-Like" license and the MIT license.  As a user of this code you may choose
to use it under either license.  As a contributor, you agree to allow your code
to be used under both.

Full text of the relevant licenses is included below.

==============================================================================

University of Illinois/NCSA
Open Source License

Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT

All rights reserved.

Developed by:

    LLVM Team

    University of Illinois at Urbana-Champaign

    http://llvm.org

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal with
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimers.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimers in the
      documentation and/or other materials provided with the distribution.

    * Neither the names of the LLVM Team, University of Illinois at
      Urbana-Champaign, nor the names of its contributors may be used to
      endorse or promote products derived from this Software without specific
      prior written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.

==============================================================================

Copyright (c) 2009-2014 by the contributors listed in CREDITS.TXT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`,
  },
  {
    component: 'Old School RuneScape Wiki datasets',
    source: 'https://oldschool.runescape.wiki/',
    license: 'CC-BY-NC-SA-3.0',
    applies: [
      'src/data/osrs/*.json — see docs/legal/data-provenance.md for each file and the transformations applied',
      'src/data/playerPresets.ts — loadouts that follow the Wiki strategy guides',
      'src/data/tilePackPresets.ts — the tile packs taken from the Wiki',
      'src/data/spellRunes.ts, src/data/itemEffects.ts — the values transcribed from Wiki tables',
    ],
    // The license text below promises adaptations are shared alike but never says
    // WHAT was adapted, and §4(c) requires the Work be identified.
    attribution: [
      "Covers the combat and equipment datasets derived from the Wiki's item, monster",
      'and spell pages, values transcribed from its tables, and the loadouts and tile',
      'markers taken from its strategy guides. They are reproduced with modifications.',
    ],
    text: `By Old School RuneScape Wiki contributors
(https://oldschool.runescape.wiki/w/Old_School_RuneScape_Wiki:Contributors).

Licensed under Creative Commons Attribution-NonCommercial-ShareAlike 3.0.
Full terms: https://creativecommons.org/licenses/by-nc-sa/3.0/

This data is not covered by the MIT license of the code around it. Its
NonCommercial and ShareAlike terms apply to anyone who redistributes it or an
adaptation of it.`,
  },
  {
    component: 'Old School RuneScape game content',
    source: 'https://www.jagex.com/',
    license: 'Owned by Jagex Ltd; not licensed by this project',
    // None of these is in the repository. `npm run setup` downloads or generates each one on the
    // machine that runs it, and a build made there carries them.
    applies: [
      'public/osrs-cache/** — the pinned cache from https://archive.openrs2.org, trimmed by scripts/trim-cache.ts',
      'public/assets/ui/**, public/assets/encounters/**, public/*_click*.webp — sprites generated from the cache by scripts/setup.ts',
      'public/fonts/*.ttf — bitmap fonts generated from the cache glyphs by scripts/setup.ts',
      'public/assets/items/** — downloaded from https://static.runelite.net/cache/item/icon by scripts/fetch-item-icons.ts',
      'Game names, messages and dialogue in the source',
    ],
    text: `RuneScape and Old School RuneScape are trademarks of Jagex Ltd. The game data,
art, names and text in this build belong to Jagex Ltd. Whoever ran this build's
setup step downloaded the game cache and item icons, under Jagex's terms, and
generated the sprites, fonts and map from that cache. None of it is part of
this project's code or covered by its license.

This is an unofficial fan project. It is not affiliated with or endorsed by
Jagex Ltd.`,
  },
];
