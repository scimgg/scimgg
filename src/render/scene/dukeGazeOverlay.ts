import { DUKE_GAZE_DURATION_TICKS, DUKE_GAZE_OVERLAY } from '../../encounters/duke/constants';
import { ModelData } from '../../rs/model/ModelData';
import type { ModelLoader } from '../../rs/model/ModelLoader';
import type { AnimationSystem } from '../backends/picogl/AnimationSystem';
import { CLIENT_TICK_MS, GAME_TICK_MS } from '../core/animation';
import type { NpcMesh3DCommand, RenderQueue } from '../core/commands';

// This flat interface model spans 1400 × 1088 model units around the screen center.
const MODEL_TO_CLIP = Float32Array.of(1 / 700, 0, 0, 0, 0, -1 / 544, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);

function overlayMesh(model: ModelData, faceOrder: readonly number[], frameId: number): NpcMesh3DCommand {
  const positions = new Float32Array(faceOrder.length * 9);
  const colors = new Float32Array(faceOrder.length * 3);
  const alphas = new Float32Array(faceOrder.length * 3);
  for (const [index, face] of faceOrder.entries()) {
    const vertices = [model.indices1[face], model.indices2[face], model.indices3[face]];
    for (const [corner, vertex] of vertices.entries()) {
      const offset = index * 3 + corner;
      positions[offset * 3] = model.verticesX[vertex];
      positions[offset * 3 + 1] = model.verticesY[vertex];
      colors[offset] = model.faceColors[face];
      alphas[offset] = 1 - ((model.faceAlphas?.[face] ?? 0) & 255) / 255;
    }
  }
  return {
    kind: 'mesh3d',
    meshId: `duke-gaze-overlay-${frameId}`,
    materialId: 'duke-gaze-overlay',
    modelMatrix: MODEL_TO_CLIP,
    clipSpace: true,
    depth: 'none',
    blend: 'normal',
    cullFace: 'none',
    positions,
    perVertexHslColors: colors,
    perVertexAlphas: alphas,
  };
}

export class DukeGazeOverlay {
  private frames: { endCycle: number; mesh: NpcMesh3DCommand }[] = [];

  load(loader: ModelLoader, animation: AnimationSystem): void {
    const model = loader.getModel(DUKE_GAZE_OVERLAY.modelId);
    if (!model) return;
    model.computeAnimationTables();
    const priorities = model.faceRenderPriorities;
    const faceOrder = Array.from({ length: model.faceCount }, (_, face) => face);
    if (priorities) faceOrder.sort((left, right) => priorities[left] - priorities[right]);

    const meshes = new Map<number, NpcMesh3DCommand>();
    const frames = [];
    let endCycle = 0;
    for (const sequenceId of DUKE_GAZE_OVERLAY.sequenceIds) {
      const sequence = animation.loadSeqType(sequenceId);
      if (!sequence?.frameIds.length) return;
      for (const [index, frameId] of sequence.frameIds.entries()) {
        let mesh = meshes.get(frameId);
        if (!mesh) {
          const frame = animation.loadFrame(frameId);
          if (!frame) return;
          const posed = ModelData.copyFrom(model, true, false, true, true, false);
          posed.animate(frame);
          mesh = overlayMesh(posed, faceOrder, frameId);
          meshes.set(frameId, mesh);
        }
        endCycle += sequence.frameLengths[index];
        frames.push({ endCycle, mesh });
      }
    }
    this.frames = frames;
  }

  draw(queue: RenderQueue, ticksSinceWindup: number): void {
    if (ticksSinceWindup < 0 || ticksSinceWindup >= DUKE_GAZE_DURATION_TICKS) return;
    const cycle = ticksSinceWindup * (GAME_TICK_MS / CLIENT_TICK_MS);
    const frame = this.frames.find(({ endCycle }) => cycle < endCycle);
    if (frame) queue.commands.push(frame.mesh);
  }
}
