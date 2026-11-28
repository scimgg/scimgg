// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextureLoader } from '../../../rs/texture/TextureLoader';
import {
  collectGarbage,
  collectGarbageAfterJob,
  collectGarbageUntilCleared,
} from '../../../test/helpers/collectGarbage';
import { recordGlDrawState } from '../../../test/helpers/glDrawStateRecorder';
import { createMockRenderFrame, createMockViewport } from '../../../test/helpers/renderer-helpers';
import { log } from '../../../util/Logger';
import { perfFlags } from '../../../util/PerfFlags';
import { renderStats } from '../../../util/RenderStats';
import type { Mesh3DCommand, NpcMesh3DCommand, ResidentMesh3DCommand } from '../../core/commands';
import { ImmutableMeshSource, type MeshSourceScope, type MeshUploadData } from '../../core/meshSource';
import { getRasterDimensions } from '../../core/raster';
import {
  type RendererInitOptions,
  RendererUnsupportedError,
  type RenderFrame,
  type RenderStatus,
} from '../../core/renderer';
import { SpotAnimRenderer } from '../../effects/SpotAnimRenderer';
import { createSpotAnimMeshParts } from '../../effects/spotAnimMeshParts';
import { Projection3D } from '../../projections/Projection3D';
import { uploadAtlas } from './instanceAtlas';
import {
  CONTEXT_RESTORE_TIMEOUT_MS,
  createPicoGLRenderer,
  detectWebGL2Features,
  isUsableWebGL2Context,
  isWebGL2Available,
  PicoGLRenderer,
} from './PicoGLRenderer';
import sceneFragSource from './shaders/scene.frag.glsl';
import sceneBaseVertSource from './shaders/scene-base.vert.glsl';
import sceneEffectsVertSource from './shaders/scene-effects.vert.glsl';

type TestMeshCommand = Mesh3DCommand & {
  positions: Float32Array;
  indices?: Uint16Array | Uint32Array;
  animated?: boolean;
};

function createIdentityMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * Floats 0, 1, 2, ...: no two vertices of a soup built from them are equal, so it uploads as the soup
 * it is rather than as an indexed mesh.
 */
function distinctFloats(length: number): Float32Array {
  return new Float32Array(length).map((_, index) => index);
}

function createTestMeshCommand(overrides: Partial<TestMeshCommand> = {}): TestMeshCommand {
  return {
    kind: 'mesh3d',
    meshId: 'test-mesh',
    materialId: 'test-material',
    modelMatrix: createIdentityMatrix(),
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    ...overrides,
  };
}

function createPositionedCommands(origins: readonly (readonly [number, number, number])[]): TestMeshCommand[] {
  return origins.map((origin, index) => {
    const modelMatrix = createIdentityMatrix();
    modelMatrix.set(origin, 12);
    return createTestMeshCommand({
      meshId: `mesh-${index}`,
      modelMatrix,
      // Distinct vertices, so the soup is drawn as it is rather than indexed.
      positions: distinctFloats((index + 1) * 9),
      depth: 'read',
    });
  });
}

function getDrawCounts(mockGL: WebGL2RenderingContext): number[] {
  return vi.mocked(mockGL.drawArrays).mock.calls.map(([, , count]) => count);
}

type MockUniformLocation = WebGLUniformLocation & { readonly name?: string };

function isMockUniformLocation(value: unknown): value is MockUniformLocation {
  return typeof value === 'object' && value !== null && 'name' in value;
}

function getUniform1fValues(mockGL: WebGL2RenderingContext, uniformName: string): number[] {
  return vi
    .mocked(mockGL.uniform1f)
    .mock.calls.filter(([location]) => isMockUniformLocation(location) && location.name === uniformName)
    .map(([, value]) => value);
}

class MockWebGL2RenderingContext {}

function createComprehensiveMockGL(): WebGL2RenderingContext {
  const mockGL = Object.assign(new MockWebGL2RenderingContext(), {
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    GREATER: 0x0204,
    LEQUAL: 0x0203,
    BACK: 0x0405,
    FRONT: 0x0404,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    TEXTURE_2D: 0x0de1,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    DEPTH_COMPONENT24: 0x81a6,
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    ACTIVE_ATTRIBUTES: 0x8b89,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x100,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_INT: 0x1405,
    TRIANGLES: 0x0004,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    POLYGON_OFFSET_FILL: 0x8037,
    RGBA32F: 0x8814,
    UNPACK_ALIGNMENT: 0x0cf5,
    NO_ERROR: 0,

    getParameter: vi.fn((pname: number) => {
      if (pname === 0x0d33) return 4096;
      if (pname === 0x88ff) return 256;
      return 0;
    }),
    getExtension: vi.fn((name: string) => {
      if (name === 'EXT_texture_filter_anisotropic') {
        return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff };
      }
      if (name === 'WEBGL_multi_draw') {
        return {};
      }
      return null;
    }),
    enable: vi.fn(),
    disable: vi.fn(),
    depthFunc: vi.fn(),
    cullFace: vi.fn(),
    frontFace: vi.fn(),
    blendFunc: vi.fn(),
    blendFuncSeparate: vi.fn(),
    clearColor: vi.fn(),
    clearDepth: vi.fn(),
    clear: vi.fn(),
    viewport: vi.fn(),
    scissor: vi.fn(),
    activeTexture: vi.fn(),
    createTexture: vi.fn(() => ({ __id: Math.random() })),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texImage3D: vi.fn(),
    texStorage2D: vi.fn(),
    texStorage3D: vi.fn(),
    texSubImage2D: vi.fn(),
    texSubImage3D: vi.fn(),
    texParameteri: vi.fn(),
    texParameterf: vi.fn(),
    generateMipmap: vi.fn(),
    deleteTexture: vi.fn(),
    pixelStorei: vi.fn(),
    createBuffer: vi.fn(() => ({ __id: Math.random() })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
    deleteBuffer: vi.fn(),
    bindBufferBase: vi.fn(),
    bindBufferRange: vi.fn(),
    createVertexArray: vi.fn(() => ({ __id: Math.random() })),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribIPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttrib1f: vi.fn(),
    vertexAttrib2f: vi.fn(),
    vertexAttrib3f: vi.fn(),
    vertexAttrib4f: vi.fn(),
    createProgram: vi.fn(() => ({ __id: Math.random() })),
    createShader: vi.fn(() => ({ __id: Math.random() })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    attachShader: vi.fn(),
    detachShader: vi.fn(),
    linkProgram: vi.fn(),
    validateProgram: vi.fn(),
    getProgramParameter: vi.fn((_, pname: number) => {
      if (pname === 0x8b82) return true;
      if (pname === 0x8b86) return 0;
      if (pname === 0x8b89) return 0;
      return null;
    }),
    getProgramInfoLog: vi.fn(() => ''),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn((_program: WebGLProgram, name: string) => ({ __id: Math.random(), name })),
    getUniformBlockIndex: vi.fn(() => 0),
    uniformBlockBinding: vi.fn(),
    getActiveUniform: vi.fn(() => null),
    getActiveAttrib: vi.fn(() => null),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform1iv: vi.fn(),
    uniform1fv: vi.fn(),
    uniform2fv: vi.fn(),
    uniform3fv: vi.fn(),
    uniform4fv: vi.fn(),
    uniformMatrix3fv: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    createFramebuffer: vi.fn(() => ({ __id: Math.random() })),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    framebufferTextureLayer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteFramebuffer: vi.fn(),
    drawBuffers: vi.fn(),
    readBuffer: vi.fn(),
    createRenderbuffer: vi.fn(() => ({ __id: Math.random() })),
    bindRenderbuffer: vi.fn(),
    renderbufferStorage: vi.fn(),
    framebufferRenderbuffer: vi.fn(),
    deleteRenderbuffer: vi.fn(),
    drawArrays: vi.fn(),
    drawElements: vi.fn(),
    drawElementsInstanced: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    isEnabled: vi.fn(() => false),
    getError: vi.fn(() => 0),
    flush: vi.fn(),
    finish: vi.fn(),
    colorMask: vi.fn(),
    depthMask: vi.fn(),
    stencilMask: vi.fn(),
    polygonOffset: vi.fn(),
    sampleCoverage: vi.fn(),
    lineWidth: vi.fn(),
    hint: vi.fn(),
    createQuery: vi.fn(() => ({ __id: Math.random() })),
    deleteQuery: vi.fn(),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    getQueryParameter: vi.fn(() => null),
    createSampler: vi.fn(() => ({ __id: Math.random() })),
    deleteSampler: vi.fn(),
    bindSampler: vi.fn(),
    samplerParameteri: vi.fn(),
    samplerParameterf: vi.fn(),
    createTransformFeedback: vi.fn(() => ({ __id: Math.random() })),
    deleteTransformFeedback: vi.fn(),
    bindTransformFeedback: vi.fn(),
    beginTransformFeedback: vi.fn(),
    endTransformFeedback: vi.fn(),
    transformFeedbackVaryings: vi.fn(),
    fenceSync: vi.fn(() => ({ __id: Math.random() })),
    deleteSync: vi.fn(),
    clientWaitSync: vi.fn(() => 0),
    waitSync: vi.fn(),
    getSyncParameter: vi.fn(() => null),
    canvas: document.createElement('canvas'),
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    isContextLost: vi.fn(() => false),
  });

  return mockGL as unknown as WebGL2RenderingContext;
}

function loseContext(target: HTMLCanvasElement): Event {
  const event = new Event('webglcontextlost', { cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function restoreContext(target: HTMLCanvasElement): void {
  target.dispatchEvent(new Event('webglcontextrestored'));
}

const LINK_STATUS = 0x8b82;

/** Makes the `failing`-th program link (1-based, in compile order) fail; the rest link. */
function failProgramLink(gl: WebGL2RenderingContext, failing: number): void {
  let linkChecks = 0;
  vi.mocked(gl.getProgramParameter).mockImplementation(((_program: unknown, pname: number) => {
    if (pname === LINK_STATUS) return ++linkChecks !== failing;
    return 0;
  }) as never);
}

function setVisibility(
  visibility: { mockReturnValue(value: DocumentVisibilityState): unknown },
  state: DocumentVisibilityState,
): void {
  visibility.mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

function lastNonNullArg<T>(
  calls: readonly (readonly unknown[])[],
  index: number,
  filter?: (call: readonly unknown[]) => boolean,
): T {
  const call = [...calls].reverse().find((candidate) => candidate[index] != null && (!filter || filter(candidate)));
  if (!call) throw new Error('Expected a matching call');
  return call[index] as T;
}

function createMockTextureLoader(): TextureLoader {
  return {
    getTextureIds: () => [1, 2, 3],
    getTextureIndex: (id: number) => id - 1,
    isSmall: () => false,
    isSd: () => false,
    isTransparent: () => false,
    getAverageHsl: () => 0,
    getAnimationUv: () => [0, 0] as [number, number],
    getMaterial: (id: number) => ({
      id,
      isSmall: false,
      isSd: false,
      isTransparent: false,
      averageHsl: 0,
      animationU: 0,
      animationV: 0,
    }),
    getPixelsRgb: () => new Int32Array(128 * 128),
    getPixelsArgb: () => new Int32Array(128 * 128),
  };
}

(globalThis as unknown as { WebGL2RenderingContext: unknown }).WebGL2RenderingContext = MockWebGL2RenderingContext;

describe('PicoGLRenderer', () => {
  let canvas: HTMLCanvasElement;
  let mockGL: WebGL2RenderingContext;
  const initialSkipSort = perfFlags.skipTransparentSort;

  beforeEach(() => {
    mockGL = createComprehensiveMockGL();
    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockImplementation((contextId: string) => {
      if (contextId === 'webgl2') {
        return mockGL;
      }
      return null;
    });
  });

  afterEach(() => {
    perfFlags.skipTransparentSort = initialSkipSort;
    vi.restoreAllMocks();
  });

  describe('createPicoGLRenderer', () => {
    it('creates a renderer instance', () => {
      const renderer = createPicoGLRenderer();
      expect(renderer).toBeInstanceOf(PicoGLRenderer);
      expect(renderer.id).toBe('picogl');
    });
  });

  describe('supports', () => {
    it('returns true for 2d', () => {
      const renderer = new PicoGLRenderer();
      expect(renderer.supports('2d')).toBe(true);
    });

    it('returns true for 3d', () => {
      const renderer = new PicoGLRenderer();
      expect(renderer.supports('3d')).toBe(true);
    });
  });

  describe('init', () => {
    it.each([
      [{ antialias: true }, true],
      [{ antialias: false }, false],
      [{}, true],
      [undefined, true],
    ])('requests init options %j as antialias=%s on init and restore', (options, antialias) => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas, options);
      // Both the renderer probe and PicoGL.createApp request this context.
      expect(canvas.getContext).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(canvas.getContext).mock.calls) {
        expect(call).toEqual(['webgl2', expect.objectContaining({ antialias })]);
      }
      vi.mocked(canvas.getContext).mockClear();
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
      canvas.dispatchEvent(new Event('webglcontextrestored'));
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
      expect(canvas.getContext).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(canvas.getContext).mock.calls) {
        expect(call).toEqual(['webgl2', expect.objectContaining({ antialias })]);
      }
      renderer.dispose();
    });

    it('creates WebGL2 context', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      expect(canvas.getContext).toHaveBeenCalledWith('webgl2', expect.any(Object));
    });

    it('throws error when WebGL2 not supported', () => {
      vi.spyOn(canvas, 'getContext').mockReturnValue(null);
      const renderer = new PicoGLRenderer();
      expect(() => renderer.init(canvas)).toThrow('PicoGLRenderer: WebGL2 not supported');
      expect(() => renderer.init(canvas)).toThrow(RendererUnsupportedError);
    });

    it.each([
      { name: 'a plain object stand-in', context: () => ({ canvas }) },
      { name: 'a WebGL2-branded object missing viewport', context: () => new MockWebGL2RenderingContext() },
    ])('rejects $name as unsupported before PicoGL sees it', ({ context }) => {
      // Privacy shims can return a truthy non-context, on which PicoGL dies with
      // `this.gl.viewport is not a function`.
      vi.spyOn(canvas, 'getContext').mockReturnValue(context() as never);
      const renderer = new PicoGLRenderer();

      expect(() => renderer.init(canvas)).toThrow(RendererUnsupportedError);
      expect(renderer.getFeatures()).toBeNull();
    });

    it('detects WebGL2 features after init', () => {
      const renderer = new PicoGLRenderer();
      expect(renderer.getFeatures()).toBeNull();
      renderer.init(canvas);
      const features = renderer.getFeatures();
      expect(features).not.toBeNull();
      expect(features?.webgl2).toBe(true);
    });
  });

  describe('resize', () => {
    it('only assigns changed raster axes, while always updating logical size and GL viewport', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize({ width: 300, height: 200, dpr: 2 });
      const width = vi.spyOn(canvas, 'width', 'set');
      const height = vi.spyOn(canvas, 'height', 'set');
      const appViewport = vi.spyOn((renderer as any).app, 'viewport');
      renderer.resize({ width: 300, height: 200, dpr: 2 });
      renderer.resize({ width: 600, height: 400, dpr: 1 });
      expect(width).not.toHaveBeenCalled();
      expect(height).not.toHaveBeenCalled();
      expect(canvas.style.width).toBe('600px');
      expect(canvas.style.height).toBe('400px');
      expect(renderer.getViewport()).toEqual({ width: 600, height: 400, dpr: 1 });
      expect(appViewport).toHaveBeenCalledTimes(2);
      expect(appViewport).toHaveBeenLastCalledWith(0, 0, 600, 400);
      renderer.resize({ width: 601, height: 400, dpr: 1 });
      expect(width).toHaveBeenCalledTimes(1);
      expect(height).not.toHaveBeenCalled();
      renderer.resize({ width: 601, height: 401, dpr: 1 });
      expect(width).toHaveBeenCalledTimes(1);
      expect(height).toHaveBeenCalledTimes(1);
      renderer.dispose();
    });

    it('updates canvas dimensions', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const viewport = createMockViewport();
      renderer.resize(viewport);
      expect(canvas.width).toBe(getRasterDimensions(viewport).width);
      expect(canvas.height).toBe(getRasterDimensions(viewport).height);
    });

    it('coerces fractional DPR to integer backing dimensions', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize({ width: 301, height: 201, dpr: 1.5 });
      expect(canvas.width).toBe(451);
      expect(canvas.height).toBe(301);
    });

    it('sizes the backing store for a stretched canvas at its painted size, keeping its CSS size', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const appViewport = vi.spyOn((renderer as any).app, 'viewport');
      // Stretch to Window: laid out 1102x721, drawn 1.17x wider.
      renderer.resize({ width: 1102, height: 721, dpr: 2, paintScale: { x: 1.17, y: 1 } });
      expect(canvas.width).toBe(Math.floor(1102 * 2 * 1.17));
      expect(canvas.height).toBe(1442);
      expect(canvas.style.width).toBe('1102px');
      expect(canvas.style.height).toBe('721px');
      expect(appViewport).toHaveBeenLastCalledWith(0, 0, Math.floor(1102 * 2 * 1.17), 1442);
      renderer.dispose();
    });

    it('stores viewport for later use', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const viewport = { width: 1024, height: 768, dpr: 2 };
      renderer.resize(viewport);
      expect(renderer.getViewport()).toEqual(viewport);
    });
  });

  describe('render', () => {
    it('executes without errors', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      const frame = createMockRenderFrame();
      expect(() => renderer.render(frame)).not.toThrow();
    });

    it('clears with specified color when clear command present', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      const frame = createMockRenderFrame();
      frame.queue.clear = { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } };
      renderer.render(frame);
    });

    it('draws depthless clip-space overlays independently of the scene camera', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const frame = createMockRenderFrame();
      const modelMatrix = createIdentityMatrix();
      frame.queue.commands.push(createTestMeshCommand({ modelMatrix, clipSpace: true, depth: 'none' }));
      renderer.render(frame);
      // The mock camera has zero view and projection matrices. Applying them would collapse the overlay.
      expect(mockGL.uniformMatrix4fv).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'u_viewProjMatrix' }),
        false,
        modelMatrix,
      );
      renderer.dispose();
    });
  });

  describe('transparent command ordering', () => {
    let renderer: PicoGLRenderer;

    beforeEach(() => {
      renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.clearAllMocks();
    });

    function renderCommands(commands: TestMeshCommand[]): void {
      renderer['renderCommands'](commands, createIdentityMatrix(), 0, 0.6, 1, 1, 0, 0, 0);
    }

    it.each([
      {
        name: 'near shield precedes far blast in the queue',
        origins: [
          [0, 0, -2],
          [0, 0, -8],
        ],
      },
      {
        name: 'lateral distance exceeds the deeper view-Z origin',
        origins: [
          [0, 0, -8],
          [10, 0, -2],
        ],
      },
      {
        name: 'vertical distance exceeds the deeper view-Z origin',
        origins: [
          [0, 0, -8],
          [0, 10, -2],
        ],
      },
    ] as const)('draws far to near when $name', ({ origins }) => {
      const commands = createPositionedCommands(origins);
      commands[0].zIndex = -100;
      commands[1].zIndex = 100;

      renderCommands(commands);

      expect(getDrawCounts(mockGL)).toEqual([6, 3]);
    });

    it('preserves insertion order when origins have equal squared distances', () => {
      const commands = createPositionedCommands([
        [3, 4, 0],
        [0, 0, -5],
        [-3, 0, 4],
        [0, 0, -10],
      ]);

      renderCommands(commands);

      expect(getDrawCounts(mockGL)).toEqual([12, 3, 6, 9]);
    });

    it("draws transparentOrder 'first' commands ahead of the distance sort, in queue order", () => {
      const commands = createPositionedCommands([
        [0, 0, -8],
        [0, 0, -1],
        [0, 0, -9],
        [0, 0, -1],
      ]);
      commands[1].transparentOrder = commands[3].transparentOrder = 'first';

      renderCommands(commands);

      expect(getDrawCounts(mockGL)).toEqual([6, 12, 9, 3]);
    });

    it('leaves the source queue and mesh geometry unchanged when sorting transparent commands', () => {
      const commands = createPositionedCommands([
        [0, 0, -2],
        [0, 0, -8],
      ]);
      const originalCommands = [...commands];
      const originalGeometry = commands.map((command) => ({
        modelMatrix: command.modelMatrix.slice(),
        positions: command.positions.slice(),
      }));

      renderCommands(commands);

      expect(getDrawCounts(mockGL)).toEqual([6, 3]);
      expect(commands).toEqual(originalCommands);
      commands.forEach((command, index) => {
        expect(command).toBe(originalCommands[index]);
        expect(command.modelMatrix).toEqual(originalGeometry[index].modelMatrix);
        expect(command.positions).toEqual(originalGeometry[index].positions);
      });
    });

    it('keeps opaque, sorted and no-depth passes in insertion order when transparent order changes', () => {
      const commands = createPositionedCommands([
        [0, 0, -1],
        [0, 0, -1],
        [0, 0, -1],
        [0, 0, -1],
        [0, 0, -9],
        [0, 0, -9],
        [0, 0, -9],
        [0, 0, -9],
      ]);
      commands[1].depth = commands[5].depth = 'readwrite';
      commands[2].depth = commands[6].depth = 'sorted';
      commands[3].depth = commands[7].depth = 'none';
      commands[3].zIndex = 100;
      commands[7].zIndex = -100;

      renderCommands(commands);

      expect(getDrawCounts(mockGL)).toEqual([6, 18, 9, 21, 9, 21, 15, 3, 12, 24]);
    });

    it('retains read-only depth and explicit readwrite exceptions when transparent draws are reordered', () => {
      const commands = createPositionedCommands([
        [0, 0, -1],
        [0, 0, -3],
        [0, 0, -2],
        [0, 0, -4],
      ]);
      commands[1].depth = 'readwrite';
      commands[1].blend = 'normal';
      delete commands[2].depth;
      commands[2].blend = 'normal';
      let depthWrite = true;
      let depthTest = false;
      let blending = false;
      let depthFunction = 0;
      const draws: {
        count: number;
        depthWrite: boolean;
        depthTest: boolean;
        blending: boolean;
        depthFunction: number;
      }[] = [];
      vi.mocked(mockGL.depthMask).mockImplementation((enabled) => {
        depthWrite = enabled;
      });
      vi.mocked(mockGL.depthFunc).mockImplementation((value) => {
        depthFunction = value;
      });
      vi.mocked(mockGL.enable).mockImplementation((capability) => {
        if (capability === mockGL.DEPTH_TEST) depthTest = true;
        if (capability === mockGL.BLEND) blending = true;
      });
      vi.mocked(mockGL.disable).mockImplementation((capability) => {
        if (capability === mockGL.DEPTH_TEST) depthTest = false;
        if (capability === mockGL.BLEND) blending = false;
      });
      vi.mocked(mockGL.drawArrays).mockImplementation((_mode, _first, count) => {
        draws.push({ count, depthWrite, depthTest, blending, depthFunction });
      });

      renderCommands(commands);

      expect(draws).toEqual(
        [12, 6, 9, 3].map((count) => ({
          count,
          depthWrite: count === 6,
          depthTest: true,
          blending: true,
          depthFunction: mockGL.GREATER,
        })),
      );
      expect(mockGL.blendFuncSeparate).toHaveBeenCalledWith(
        mockGL.SRC_ALPHA,
        mockGL.ONE_MINUS_SRC_ALPHA,
        mockGL.ONE,
        mockGL.ONE,
      );
      expect(depthWrite).toBe(true);
    });

    it('uploads and draws each animated mesh immediately when reordered commands share a mesh ID', () => {
      const [near, far] = createPositionedCommands([
        [0, 0, -2],
        [0, 0, -8],
      ]);
      const nearPositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const farPositions = new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]);
      const commands = [
        { ...near, meshId: 'shared', animated: true, positions: nearPositions },
        { ...far, meshId: 'shared', animated: true, positions: farPositions },
      ];
      let uploadedPositions: Float32Array | null = null;
      const draws: (Float32Array | null)[] = [];
      vi.mocked(mockGL.bufferData).mockImplementation((_target, data) => {
        if (data instanceof Float32Array) uploadedPositions = data;
      });
      vi.mocked(mockGL.bufferSubData).mockImplementation((_target, _offset, data) => {
        if (data instanceof Float32Array) uploadedPositions = data;
      });
      vi.mocked(mockGL.drawArrays).mockImplementation(() => {
        draws.push(uploadedPositions?.slice() ?? null);
      });

      renderCommands(commands);

      expect(draws).toEqual([farPositions, nearPositions]);
      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(1);
      expect(mockGL.bufferSubData).toHaveBeenCalledWith(mockGL.ARRAY_BUFFER, 0, nearPositions);
    });

    it.each([false, true])('preserves baked geometry after a sorted instance with a primed cache=%s', (prime) => {
      perfFlags.skipTransparentSort = true;
      // Graphic 366 can be both sorted Ice Burst flight and unsorted Ice Blitz casting.
      // The second triangle is back-facing, so sorting emits only the first.
      const positions = new Float32Array([0, 0, 100, 0, 100, 100, 100, 0, 100, 0, 0, 200, 100, 0, 200, 0, 100, 200]);
      const effects = new SpotAnimRenderer();
      effects['meshCache'].set(366, {
        static: createSpotAnimMeshParts('spotanim-366', {
          positions,
          hslColors: new Float32Array(6).fill(100),
          alphas: new Float32Array(6).fill(0.5),
          faceBias: new Float32Array(6),
          modelFaceIndices: new Uint32Array([0, 1]),
        }),
        frames: [],
        frameLengths: [],
        frameStep: -1,
        heightOffset: 0,
      });
      effects.setSorterProjection({
        cameraX: 0,
        cameraY: 0,
        cameraZ: -1000,
        yawSin: 0,
        yawCos: 1,
        pitchSin: 0,
        pitchCos: 1,
      });

      let boundBuffer: WebGLBuffer | null = null;
      let boundVao: WebGLVertexArrayObject | null = null;
      const uploads = new Map<WebGLBuffer, Float32Array>();
      const draws: { count: number; positions: Float32Array | undefined }[] = [];
      vi.mocked(mockGL.bindBuffer).mockImplementation((_target, buffer) => {
        boundBuffer = buffer;
      });
      vi.mocked(mockGL.bindVertexArray).mockImplementation((vao) => {
        boundVao = vao;
      });
      vi.mocked(mockGL.bufferData).mockImplementation((_target, data) => {
        if (boundBuffer && data instanceof Float32Array) uploads.set(boundBuffer, data.slice());
      });
      vi.mocked(mockGL.bufferSubData).mockImplementation((_target, _offset, data) => {
        if (boundBuffer && data instanceof Float32Array) uploads.set(boundBuffer, data.slice());
      });
      vi.mocked(mockGL.drawArrays).mockImplementation((_mode, _first, count) => {
        const cached = [...renderer['meshVaoCache'].values()].find((entry) => entry.vao === boundVao);
        draws.push({ count, positions: cached?.posBuffer ? uploads.get(cached.posBuffer)?.slice() : undefined });
      });

      const drawEffect = (requireTransparentSort: boolean) => {
        effects.upsert({
          instanceId: 'effect',
          spotAnimId: 366,
          lifecycle: { kind: 'manual' },
          transform: { kind: 'static', value: { position: [0, 0, 0] } },
          style: { requireTransparentSort },
        });
        const queue = createMockRenderFrame().queue;
        effects.render(queue);
        expect(queue.commands).toHaveLength(1);
        const command = queue.commands[0] as NpcMesh3DCommand;
        expect(command.animated).toBe(requireTransparentSort);
        renderCommands([command]);
      };

      if (prime) drawEffect(false);
      drawEffect(true);
      drawEffect(false);

      const bakedDraw = { count: 6, positions };
      expect(draws).toEqual([...(prime ? [bakedDraw] : []), { count: 3, positions: positions.slice(0, 9) }, bakedDraw]);
    });

    it.each([
      { mode: 'orbit', yaw: 0, pitch: -30 },
      { mode: 'orbit', yaw: 73, pitch: -47 },
      { mode: 'orbit', yaw: 211, pitch: -65 },
      { mode: 'freeform', yaw: 0, pitch: 0 },
      { mode: 'freeform', yaw: 73, pitch: -47 },
      { mode: 'freeform', yaw: 211, pitch: 28 },
    ] as const)('uses the translated $mode eye at yaw $yaw and pitch $pitch in render()', ({ mode, yaw, pitch }) => {
      const camera = new Projection3D(createMockViewport(), {
        targetX: 17,
        targetY: -9,
        targetZ: 8,
        distance: 13,
        yaw,
        pitch,
      });
      camera.setCameraMode(mode);
      if (mode === 'freeform') camera.updateFreeformCamera({ posX: 17, posY: -9, posZ: 8, yaw, pitch });
      const eye = camera.getCameraWorldPosition();
      const commands = createPositionedCommands([
        [16, -8, 7],
        [25, -6, 14],
        [-16, 11, 3],
        [1, 8, -5],
        [21, 4, 2],
        [-9, -15, 23],
      ]);
      const expectedCounts = commands
        .map((command, index) => ({
          count: (index + 1) * 3,
          distance: Math.hypot(
            command.modelMatrix[12] - eye.x,
            command.modelMatrix[13] - eye.y,
            command.modelMatrix[14] - eye.z,
          ),
        }))
        .sort((left, right) => right.distance - left.distance)
        .map(({ count }) => count);
      const viewMatrix = vi.spyOn(camera, 'viewMatrix');
      const frame = createMockRenderFrame();
      frame.camera = { kind: '3d', camera };
      frame.queue.commands = commands;

      renderer.render(frame);

      expect(getDrawCounts(mockGL)).toEqual(expectedCounts);
      expect(viewMatrix).toHaveBeenCalledTimes(1);
    });
  });

  describe('animated mesh uploads', () => {
    let renderer: PicoGLRenderer;
    /** Contents each GL buffer holds, as copied at bufferData/bufferSubData time. */
    let resident: Map<WebGLBuffer, Float32Array>;
    /** Positions each draw saw, read through the bound VAO's cached position buffer. */
    let drawnPositions: (number[] | undefined)[];

    beforeEach(() => {
      renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.clearAllMocks();
      resident = new Map();
      drawnPositions = [];
      let boundBuffer: WebGLBuffer | null = null;
      let boundVao: WebGLVertexArrayObject | null = null;
      vi.mocked(mockGL.bindBuffer).mockImplementation((_target, buffer) => {
        boundBuffer = buffer;
      });
      vi.mocked(mockGL.bindVertexArray).mockImplementation((vao) => {
        boundVao = vao;
      });
      const record = (data: unknown) => {
        if (boundBuffer && data instanceof Float32Array) resident.set(boundBuffer, data.slice());
      };
      vi.mocked(mockGL.bufferData).mockImplementation(((_target: number, data: unknown) => record(data)) as never);
      vi.mocked(mockGL.bufferSubData).mockImplementation(((_target: number, _offset: number, data: unknown) =>
        record(data)) as never);
      vi.mocked(mockGL.drawArrays).mockImplementation(() => {
        const cached = [...renderer['meshVaoCache'].values()].find((entry) => entry.vao === boundVao);
        const positions = cached?.posBuffer ? resident.get(cached.posBuffer) : undefined;
        drawnPositions.push(positions ? Array.from(positions) : undefined);
      });
    });

    function draw(...commands: NpcMesh3DCommand[]): void {
      renderer['renderCommands'](commands, createIdentityMatrix(), 0, 0.6, 1, 1, 0, 0, 0);
    }

    function animatedMesh(vertexCount: number, base: number, overrides: Partial<NpcMesh3DCommand> = {}) {
      const scalar = (offset: number) => new Float32Array(vertexCount).map((_, index) => base + offset + index);
      return {
        kind: 'mesh3d',
        meshId: 'npc-1-opaque-a',
        materialId: 'osrs-npc',
        modelMatrix: createIdentityMatrix(),
        positions: new Float32Array(vertexCount * 3).map((_, index) => base + index),
        normals: new Float32Array(vertexCount * 3).fill(0.5),
        perVertexHslColors: scalar(100),
        perVertexAlphas: new Float32Array(vertexCount).fill(1),
        perVertexFaceBias: scalar(200),
        animated: true,
        ...overrides,
      } satisfies NpcMesh3DCommand;
    }

    function residentOf(meshId: string, buffer: 'posBuffer' | 'hslColorBuffer'): number[] | undefined {
      const handle = renderer['meshVaoCache'].get(meshId)?.[buffer];
      const contents = handle ? resident.get(handle) : undefined;
      return contents ? Array.from(contents) : undefined;
    }

    it('re-uploads exactly the attributes whose contents changed, including contents changed in place', () => {
      const uploads = () => {
        const data = vi.mocked(mockGL.bufferSubData).mock.calls.map(([, , uploaded]) => uploaded);
        vi.mocked(mockGL.bufferSubData).mockClear();
        return data;
      };
      // scene-effects reads normals, so its animated meshes keep a normal buffer too.
      const command = animatedMesh(6, 0, { shaderId: 'scene-effects' });
      draw(command);
      expect(uploads()).toEqual([]);

      // A transparent re-sort permutes the same arrays in place; normals, alphas and face bias
      // keep their values.
      command.positions.reverse();
      command.perVertexHslColors.reverse();
      draw(command);
      expect(uploads()).toEqual([command.positions, command.perVertexHslColors]);

      // Nothing changed: nothing is uploaded.
      draw(command);
      expect(uploads()).toEqual([]);

      // Negative zero is a different value to the GPU, though it compares equal to zero.
      command.perVertexFaceBias.fill(0);
      draw(command);
      expect(uploads()).toEqual([command.perVertexFaceBias]);
      command.perVertexFaceBias[0] = -0;
      draw(command);
      expect(uploads()).toEqual([command.perVertexFaceBias]);

      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(1);
      expect(residentOf(command.meshId, 'posBuffer')).toEqual(Array.from(command.positions));
      expect(residentOf(command.meshId, 'hslColorBuffer')).toEqual(Array.from(command.perVertexHslColors));
      expect(drawnPositions.slice(1)).toEqual([1, 2, 3, 4].map(() => Array.from(command.positions)));
    });

    it('draws the current contents when commands sharing a mesh ID alternate A -> B -> A', () => {
      const a = animatedMesh(3, 0, { meshId: 'shared' });
      const b = animatedMesh(3, 50, { meshId: 'shared' });
      draw(a);
      draw(b);
      draw(a);
      draw(a);

      expect(drawnPositions).toEqual([a, b, a, a].map((command) => Array.from(command.positions)));
    });

    it('keeps the VAO when the vertex count changes, growing storage only when the new count does not fit', () => {
      const avoided = vi.spyOn(renderStats, 'recordVaoRebuildAvoided');
      const reallocated = vi.spyOn(renderStats, 'recordBufferReallocation');
      draw(animatedMesh(3, 0));
      const cached = renderer['meshVaoCache'].get('npc-1-opaque-a')!;
      const grown = animatedMesh(6, 10);
      draw(grown);

      expect(mockGL.createVertexArray).toHaveBeenCalledOnce();
      expect(mockGL.createBuffer).toHaveBeenCalledTimes(4);
      expect(mockGL.deleteVertexArray).not.toHaveBeenCalled();
      expect(mockGL.deleteBuffer).not.toHaveBeenCalled();
      expect(renderer['meshVaoCache'].get(grown.meshId)).toBe(cached);
      // Each of the four buffers is reallocated by size, then written.
      const sizedReallocations = vi.mocked(mockGL.bufferData).mock.calls.filter(([, data]) => typeof data === 'number');
      expect(sizedReallocations.map(([, size, usage]) => [size, usage])).toEqual([
        [72, mockGL.DYNAMIC_DRAW],
        [24, mockGL.DYNAMIC_DRAW],
        [24, mockGL.DYNAMIC_DRAW],
        [24, mockGL.DYNAMIC_DRAW],
      ]);
      expect(residentOf(grown.meshId, 'posBuffer')).toEqual(Array.from(grown.positions));
      expect(cached.vertexCount).toBe(6);
      expect(cached.bytes).toBe(144);
      expect(getDrawCounts(mockGL)).toEqual([3, 6]);

      // Back down: written in place, drawn at the new count, storage kept.
      vi.mocked(mockGL.bufferData).mockClear();
      const shrunk = animatedMesh(4, 20);
      draw(shrunk);
      expect(mockGL.bufferData).not.toHaveBeenCalled();
      // Its alphas, all 1 as before, are already what the buffer starts with.
      expect(
        vi
          .mocked(mockGL.bufferSubData)
          .mock.calls.slice(-3)
          .map(([, , data]) => data),
      ).toEqual([shrunk.positions, shrunk.perVertexHslColors, shrunk.perVertexFaceBias]);
      expect(getDrawCounts(mockGL)).toEqual([3, 6, 4]);
      expect(cached.bytes).toBe(144);
      expect(avoided).toHaveBeenCalledTimes(2);
      expect(reallocated).toHaveBeenCalledTimes(4);
    });

    it('grows by half again, so a slowly growing mesh reallocates rarely', () => {
      draw(animatedMesh(30, 0));
      for (let vertexCount = 31; vertexCount <= 60; vertexCount++) draw(animatedMesh(vertexCount, 0));
      const positionSizes = vi
        .mocked(mockGL.bufferData)
        .mock.calls.filter(([, data]) => typeof data === 'number' && data >= 360)
        .map(([, size]) => size);
      // 360 bytes of positions (30 vertices), then 540, 812: two reallocations for 30 growth steps.
      expect(positionSizes).toEqual([540, 812]);
      expect(mockGL.createVertexArray).toHaveBeenCalledOnce();
    });

    it('re-uploads after eviction or a scene release', () => {
      const command = animatedMesh(3, 0);
      draw(command);
      renderer['frameCounter'] = 600;
      renderer['evictStaleCacheEntries']();
      expect(renderer['meshVaoCache'].size).toBe(0);
      resident.clear();
      draw(command);
      expect(drawnPositions[1]).toEqual(Array.from(command.positions));

      renderer.releaseSceneMeshes();
      resident.clear();
      draw(command);
      expect(drawnPositions[2]).toEqual(Array.from(command.positions));
      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(3);
      expect(mockGL.bufferSubData).not.toHaveBeenCalled();
    });

    it('survives an empty frame and uploads the next non-empty one', () => {
      const command = animatedMesh(3, 0);
      draw(command);
      draw({ ...command, positions: new Float32Array(0) });
      const back = animatedMesh(3, 30);
      draw(back);

      expect(drawnPositions).toEqual([Array.from(command.positions), Array.from(back.positions)]);
      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(1);
    });

    it('rebuilds with the right buffers when attributes appear or disappear at the same vertex count', () => {
      const untextured = animatedMesh(3, 0);
      draw(untextured);
      const textured = animatedMesh(3, 0, {
        uvs: new Float32Array(6).fill(0.25),
        perVertexTextureIds: new Float32Array(3).fill(2),
      });
      draw(textured);

      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(2);
      let cached = renderer['meshVaoCache'].get(untextured.meshId)!;
      expect(cached.uvBuffer && Array.from(resident.get(cached.uvBuffer)!)).toEqual(Array.from(textured.uvs!));
      expect(cached.textureIdBuffer && Array.from(resident.get(cached.textureIdBuffer)!)).toEqual(
        Array.from(textured.perVertexTextureIds!),
      );
      expect(mockGL.bufferSubData).not.toHaveBeenCalled();

      const bare = animatedMesh(3, 20, { normals: undefined });
      draw(bare);

      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(3);
      cached = renderer['meshVaoCache'].get(untextured.meshId)!;
      expect(cached.uvBuffer).toBeUndefined();
      expect(cached.textureIdBuffer).toBeUndefined();
      expect(cached.normBuffer).toBeUndefined();
      expect(residentOf(bare.meshId, 'posBuffer')).toEqual(Array.from(bare.positions));
      expect(mockGL.bufferSubData).not.toHaveBeenCalled();
    });

    it('records the bytes createMeshVao uploads', () => {
      const recordBufferUpload = vi.spyOn(renderStats, 'recordBufferUpload');
      const command = animatedMesh(3, 0);
      draw(command);
      // positions (36 bytes) and hsl, alpha, face bias (12 bytes each); scene-base reads no normals.
      const bytes = recordBufferUpload.mock.calls.map(([uploaded]) => uploaded);
      expect(bytes).toHaveLength(4);
      expect(bytes.reduce((sum, uploaded) => sum + uploaded, 0)).toBe(72);
    });
  });

  describe('animated meshes drawn through a stateful GL', () => {
    type SimBuffer = { storage: Uint8Array; deleted: boolean };
    type SimAttribute = { buffer: SimBuffer; size: number };
    type SimVao = {
      attributes: Map<number, SimAttribute>;
      enabled: Set<number>;
      elements: SimBuffer | null;
      deleted: boolean;
    };
    /** What one draw call read: every vertex's value at each enabled location, and the constants of the rest. */
    type DrawRecord = { count: number; arrays: Record<number, number[]>; constants: Record<number, number[]> };

    /**
     * Replaces the mock's buffer, VAO, attribute and draw calls with ones that keep storage and
     * binding state like a real context, so a draw reads back exactly the values the GPU would.
     * Out-of-range writes or reads and use of deleted objects are recorded as errors.
     */
    function statefulGL(gl: WebGL2RenderingContext) {
      const state = {
        draws: [] as DrawRecord[],
        errors: [] as string[],
        created: { vaos: 0, buffers: 0 },
        deleted: { vaos: 0, buffers: 0 },
      };
      const defaultVao: SimVao = { attributes: new Map(), enabled: new Set(), elements: null, deleted: false };
      let vao = defaultVao;
      let arrayBuffer: SimBuffer | null = null;
      let generics = new Map<number, number[]>();
      const bound = (target: number) => (target === gl.ELEMENT_ARRAY_BUFFER ? vao.elements : arrayBuffer);
      const live = (buffer: SimBuffer | null, call: string): SimBuffer | null => {
        if (!buffer || buffer.deleted) {
          state.errors.push(`${call} without a live buffer`);
          return null;
        }
        return buffer;
      };
      const bytesOf = (data: ArrayBufferView) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      Object.assign(gl, {
        createBuffer: vi.fn(() => {
          state.created.buffers++;
          return { storage: new Uint8Array(0), deleted: false } satisfies SimBuffer;
        }),
        deleteBuffer: vi.fn((buffer: SimBuffer) => {
          state.deleted.buffers++;
          buffer.deleted = true;
        }),
        bindBuffer: vi.fn((target: number, buffer: SimBuffer | null) => {
          if (target === gl.ELEMENT_ARRAY_BUFFER) vao.elements = buffer;
          else arrayBuffer = buffer;
        }),
        bufferData: vi.fn((target: number, data: number | ArrayBufferView) => {
          const buffer = live(bound(target), 'bufferData');
          if (buffer) buffer.storage = typeof data === 'number' ? new Uint8Array(data) : bytesOf(data).slice();
        }),
        bufferSubData: vi.fn((target: number, offset: number, data: ArrayBufferView) => {
          const buffer = live(bound(target), 'bufferSubData');
          if (!buffer) return;
          if (offset + data.byteLength > buffer.storage.length) state.errors.push('bufferSubData past the end');
          else buffer.storage.set(bytesOf(data), offset);
        }),
        createVertexArray: vi.fn(() => {
          state.created.vaos++;
          return { attributes: new Map(), enabled: new Set(), elements: null, deleted: false } satisfies SimVao;
        }),
        deleteVertexArray: vi.fn((target: SimVao) => {
          state.deleted.vaos++;
          target.deleted = true;
        }),
        bindVertexArray: vi.fn((target: SimVao | null) => {
          if (target?.deleted) state.errors.push('bound a deleted VAO');
          vao = target ?? defaultVao;
        }),
        enableVertexAttribArray: vi.fn((location: number) => vao.enabled.add(location)),
        disableVertexAttribArray: vi.fn((location: number) => vao.enabled.delete(location)),
        vertexAttribPointer: vi.fn((location: number, size: number) => {
          const buffer = live(arrayBuffer, 'vertexAttribPointer');
          if (buffer) vao.attributes.set(location, { buffer, size });
        }),
        vertexAttrib1f: vi.fn((location: number, x: number) => generics.set(location, [x, 0, 0, 1])),
        vertexAttrib2f: vi.fn((location: number, x: number, y: number) => generics.set(location, [x, y, 0, 1])),
        drawArrays: vi.fn((_mode: number, first: number, count: number) => {
          state.draws.push(read(Array.from({ length: count }, (_, index) => first + index)));
        }),
        drawElements: vi.fn((_mode: number, count: number, type: number, offset: number) => {
          const elements = live(vao.elements, 'drawElements');
          if (!elements) return;
          const width = type === gl.UNSIGNED_SHORT ? 2 : 4;
          if (offset + count * width > elements.storage.length) {
            state.errors.push('drawElements past the index buffer');
            return;
          }
          const view = new DataView(elements.storage.buffer, elements.storage.byteOffset);
          const indices = Array.from({ length: count }, (_, index) =>
            width === 2 ? view.getUint16(offset + index * 2, true) : view.getUint32(offset + index * 4, true),
          );
          state.draws.push(read(indices));
        }),
      });
      function read(vertices: readonly number[]): DrawRecord {
        if (vao.deleted) state.errors.push('drew a deleted VAO');
        const record: DrawRecord = { count: vertices.length, arrays: {}, constants: {} };
        for (let location = 0; location < 8; location++) {
          const attribute = vao.attributes.get(location);
          if (!vao.enabled.has(location) || !attribute) {
            record.constants[location] = generics.get(location) ?? [0, 0, 0, 1];
            continue;
          }
          const floats = new Float32Array(
            attribute.buffer.storage.buffer,
            attribute.buffer.storage.byteOffset,
            attribute.buffer.storage.byteLength / 4,
          );
          const values: number[] = [];
          for (const vertex of vertices) {
            if ((vertex + 1) * attribute.size > floats.length)
              state.errors.push(`location ${location} read past the end`);
            for (let component = 0; component < attribute.size; component++) {
              values.push(floats[vertex * attribute.size + component] ?? Number.NaN);
            }
          }
          record.arrays[location] = values;
        }
        return record;
      }
      /** A restored context: every object of the lost one is gone, every constant back to its default. */
      const resetContext = () => {
        generics = new Map();
        vao = defaultVao;
        defaultVao.attributes.clear();
        defaultVao.enabled.clear();
        arrayBuffer = null;
      };
      return { state, resetContext };
    }

    function mesh(meshId: string, vertexCount: number, seed: number, extra: Partial<NpcMesh3DCommand> = {}) {
      const values = (length: number, offset: number) =>
        new Float32Array(length).map((_, index) => seed * 1000 + offset + index);
      return {
        kind: 'mesh3d',
        meshId,
        materialId: 'osrs-npc',
        modelMatrix: createIdentityMatrix(),
        positions: values(vertexCount * 3, 0),
        normals: values(vertexCount * 3, 100),
        perVertexHslColors: values(vertexCount, 200),
        perVertexAlphas: values(vertexCount, 300).map((value) => (value % 7) / 7),
        perVertexFaceBias: values(vertexCount, 400),
        animated: true,
        ...extra,
      } satisfies NpcMesh3DCommand as NpcMesh3DCommand;
    }

    function textured(command: NpcMesh3DCommand): NpcMesh3DCommand {
      const vertexCount = command.positions.length / 3;
      return {
        ...command,
        uvs: new Float32Array(vertexCount * 2).map((_, index) => index / 10),
        perVertexTextureIds: new Float32Array(vertexCount).fill(3),
      };
    }

    /** Reversed triangle order over a vertex buffer twice the triangles' size, with tile coordinates. */
    function indexed(command: NpcMesh3DCommand): NpcMesh3DCommand & { indices: Uint16Array } {
      const vertexCount = command.positions.length / 3;
      return {
        ...command,
        tileCoords: new Float32Array(vertexCount * 2).map((_, index) => index),
        indices: new Uint16Array(vertexCount).map((_, index) => vertexCount - 1 - index),
      } as NpcMesh3DCommand & { indices: Uint16Array };
    }

    /** What a renderer that has never seen the mesh draws for it: a full rebuild, every time. */
    function freshDraws(commands: readonly NpcMesh3DCommand[]): DrawRecord[] {
      const gl = createComprehensiveMockGL();
      const { state } = statefulGL(gl);
      const target = document.createElement('canvas');
      vi.spyOn(target, 'getContext').mockReturnValue(gl);
      const fresh = new PicoGLRenderer();
      fresh.init(target);
      const frame = createMockRenderFrame();
      frame.queue.commands = [...commands];
      fresh.render(frame);
      fresh.dispose();
      expect(state.errors).toEqual([]);
      return state.draws;
    }

    it('draws exactly what a rebuild would, frame by frame, as counts rise and fall, layouts switch and the context is lost', () => {
      vi.useFakeTimers();
      try {
        const { state, resetContext } = statefulGL(mockGL);
        const renderer = new PicoGLRenderer();
        renderer.init(canvas);
        const avoided = vi.spyOn(renderStats, 'recordVaoRebuildAvoided');
        type Step = {
          readonly npc: number;
          readonly variant: 'plain' | 'textured' | 'effects';
          readonly effect: number;
        };
        // An npc mesh and an indexed, tile-coordinated effect mesh whose vertex counts move independently.
        const script: (Step | 'context lost')[] = [
          { npc: 3, variant: 'plain', effect: 6 },
          { npc: 9, variant: 'plain', effect: 12 },
          { npc: 6, variant: 'plain', effect: 3 },
          { npc: 3, variant: 'plain', effect: 12 },
          { npc: 12, variant: 'plain', effect: 18 },
          { npc: 12, variant: 'textured', effect: 6 }, // layout change: rebuild
          { npc: 6, variant: 'textured', effect: 6 },
          { npc: 15, variant: 'textured', effect: 24 },
          'context lost',
          { npc: 9, variant: 'textured', effect: 9 },
          { npc: 3, variant: 'textured', effect: 3 },
          { npc: 6, variant: 'effects', effect: 12 }, // normals now read: rebuild
          { npc: 18, variant: 'effects', effect: 6 },
          { npc: 3, variant: 'plain', effect: 3 }, // normals no longer read: rebuild
        ];
        const frame = createMockRenderFrame();
        for (const [index, step] of script.entries()) {
          if (step === 'context lost') {
            loseContext(canvas);
            resetContext();
            restoreContext(canvas);
            continue;
          }
          const plain = mesh('npc-7-opaque', step.npc, index);
          const npc =
            step.variant === 'textured'
              ? textured(plain)
              : step.variant === 'effects'
                ? { ...plain, shaderId: 'scene-effects' as const }
                : plain;
          const effect = indexed(mesh('spotanim-1-transparent-sorted', step.effect, index + 50, { depth: 'read' }));
          state.draws.length = 0;
          frame.queue.commands = [npc, effect];
          renderer.render(frame);

          expect({ frame: index, draws: state.draws }).toEqual({ frame: index, draws: freshDraws([npc, effect]) });
        }

        expect(state.errors).toEqual([]);
        // Two meshes created, the npc rebuilt for 3 layout changes, both rebuilt once after the restore.
        expect(state.created.vaos).toBe(2 + 3 + 2);
        expect(state.deleted.vaos).toBe(3);
        // Every other count change: 8 for the npc, 10 for the effect.
        expect(avoided).toHaveBeenCalledTimes(18);
        // Live storage is what the cache reports, capacity included.
        const cachedBytes = [...renderer['meshVaoCache'].values()].reduce((sum, cached) => sum + cached.bytes, 0);
        const slots = [...renderer['meshVaoCache'].values()].flatMap((cached) => cached.slots);
        expect(cachedBytes).toBe(
          slots.reduce((sum, slot) => sum + (slot.buffer as unknown as SimBuffer).storage.length, 0),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('rebuilds an indexed mesh whose index type changes with its count', () => {
      const { state } = statefulGL(mockGL);
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const frame = createMockRenderFrame();
      const small = indexed(mesh('big-1', 6, 1));
      const large = { ...indexed(mesh('big-1', 9, 2)), indices: new Uint32Array([8, 7, 6, 5, 4, 3, 2, 1, 0]) };
      for (const command of [small, large, small]) {
        state.draws.length = 0;
        frame.queue.commands = [command];
        renderer.render(frame);
        expect(state.draws).toEqual(freshDraws([command]));
      }
      expect(state.created.vaos).toBe(3);
      expect(state.errors).toEqual([]);
    });
  });

  describe('attribute buffers follow the program contract', () => {
    const NORMAL_LOCATION = 1;
    const ALPHA_LOCATION = 6;
    let renderer: PicoGLRenderer;

    beforeEach(() => {
      renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.clearAllMocks();
    });

    function draw(...commands: NpcMesh3DCommand[]): void {
      renderer['renderCommands'](commands, createIdentityMatrix(), 0, 0.6, 1, 1, 0, 0, 0);
    }

    function staticMesh(overrides: Partial<NpcMesh3DCommand> = {}): NpcMesh3DCommand {
      return {
        kind: 'mesh3d',
        meshId: 'merged-static-locs-opaque',
        materialId: 'osrs-npc',
        modelMatrix: createIdentityMatrix(),
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        perVertexHslColors: new Float32Array([100, 100, 100]),
        perVertexAlphas: new Float32Array([1, 1, 1]),
        ...overrides,
      };
    }

    function uploaded(data: Float32Array | undefined): boolean {
      return vi.mocked(mockGL.bufferData).mock.calls.some(([, source]) => source === data);
    }

    function pointedLocations(): number[] {
      return vi.mocked(mockGL.vertexAttribPointer).mock.calls.map(([location]) => location);
    }

    it('matches the shader sources: only scene-effects declares a_normal', () => {
      const declaresNormal = /\bin\s+vec3\s+a_normal\b/;
      expect(declaresNormal.test(sceneBaseVertSource)).toBe(false);
      expect(declaresNormal.test(sceneEffectsVertSource)).toBe(true);
      expect(sceneFragSource).not.toMatch(/\bv_normal\b/);
    });

    it('gives a scene-base mesh no normal buffer', () => {
      const command = staticMesh();
      draw(command);

      expect(uploaded(command.normals)).toBe(false);
      expect(pointedLocations()).not.toContain(NORMAL_LOCATION);
      expect(renderer['meshVaoCache'].get(command.meshId)?.normBuffer).toBeUndefined();
      expect(mockGL.drawArrays).toHaveBeenCalledOnce();
    });

    it('uploads normals for a scene-effects mesh, which reads them as procedural seeds', () => {
      const command = staticMesh({ meshId: 'lobby-fx', shaderId: 'scene-effects' });
      draw(command);

      expect(uploaded(command.normals)).toBe(true);
      expect(pointedLocations()).toContain(NORMAL_LOCATION);
      expect(renderer['meshVaoCache'].get(command.meshId)?.normBuffer).toBeDefined();
    });

    it('rebuilds a cached scene-base VAO with normals when the mesh id is drawn with scene-effects', () => {
      draw(staticMesh({ meshId: 'shared' }));
      const effects = staticMesh({ meshId: 'shared', shaderId: 'scene-effects' });
      draw(effects);

      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(2);
      expect(mockGL.deleteVertexArray).toHaveBeenCalledOnce();
      expect(uploaded(effects.normals)).toBe(true);
      expect(renderer['meshVaoCache'].get('shared')?.normBuffer).toBeDefined();

      // Drawing it with scene-base again keeps the normal-bearing VAO rather than churning.
      draw(staticMesh({ meshId: 'shared' }));
      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(2);
    });

    it('drops the alpha buffer of an all-opaque static mesh and draws from the constant alpha of 1', () => {
      const command = staticMesh();
      draw(command);

      expect(uploaded(command.perVertexAlphas)).toBe(false);
      expect(pointedLocations()).not.toContain(ALPHA_LOCATION);
      expect(renderer['meshVaoCache'].get(command.meshId)?.alphaBuffer).toBeUndefined();
      expect(mockGL.disableVertexAttribArray).toHaveBeenCalledWith(ALPHA_LOCATION);
      // 1 is the only value the renderer ever gives the a_alpha constant.
      const alphaConstants = vi
        .mocked(mockGL.vertexAttrib1f)
        .mock.calls.filter(([location]) => location === ALPHA_LOCATION)
        .map(([, value]) => value);
      expect(new Set(alphaConstants)).toEqual(new Set([1]));
    });

    it('keeps the alpha buffer of a static mesh with any translucent vertex', () => {
      const command = staticMesh({
        meshId: 'merged-static-locs-transparent',
        perVertexAlphas: new Float32Array([1, 0.5, 1]),
      });
      draw(command);

      expect(uploaded(command.perVertexAlphas)).toBe(true);
      expect(renderer['meshVaoCache'].get(command.meshId)?.alphaBuffer).toBeDefined();
    });

    it('keeps the alpha buffer of an all-opaque animated mesh, whose alphas may change between draws', () => {
      const command = staticMesh({ meshId: 'npc-1-opaque-a', animated: true });
      draw(command);
      command.perVertexAlphas?.fill(0.25);
      draw(command);

      expect(renderer['meshVaoCache'].get(command.meshId)?.alphaBuffer).toBeDefined();
      expect(mockGL.createVertexArray).toHaveBeenCalledOnce();
      expect(mockGL.bufferSubData).toHaveBeenCalledWith(mockGL.ARRAY_BUFFER, 0, command.perVertexAlphas);
    });
  });

  describe('RuneLite blend / shader depth-bias contract', () => {
    let renderer: PicoGLRenderer;
    let frame: ReturnType<typeof createMockRenderFrame>;

    beforeEach(() => {
      renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      vi.clearAllMocks();
      frame = createMockRenderFrame();
      // A single mesh command drives renderCommands() so the transparent-pass
      // setup runs and we can observe its blend / bias contract.
      frame.queue.commands = [createTestMeshCommand()];
    });

    it('uses gl.blendFuncSeparate with RuneLite-matching factors on the transparent pass', () => {
      renderer.render(frame);
      expect(mockGL.blendFuncSeparate).toHaveBeenCalledWith(
        mockGL.SRC_ALPHA,
        mockGL.ONE_MINUS_SRC_ALPHA,
        mockGL.ONE,
        mockGL.ONE,
      );
    });

    it('never calls gl.polygonOffset — RuneLite parity path has no depth-bias hack', () => {
      renderer.render(frame);
      expect(mockGL.polygonOffset).not.toHaveBeenCalled();
    });

    it('applies command depthBias through shader z-bias without polygonOffset', () => {
      frame.queue.commands = [createTestMeshCommand({ depthBias: 0.25 })];

      renderer.render(frame);

      expect(getUniform1fValues(mockGL, 'u_zBias')).toContain(0.25);
      expect(mockGL.polygonOffset).not.toHaveBeenCalled();
    });

    it('resets shader z-bias for an unbiased command after a biased command', () => {
      frame.queue.commands = [
        createTestMeshCommand({ meshId: 'biased-mesh', depthBias: 0.25 }),
        createTestMeshCommand({ meshId: 'plain-mesh' }),
      ];

      renderer.render(frame);

      const zBiasValues = getUniform1fValues(mockGL, 'u_zBias');
      const biasedIndex = zBiasValues.indexOf(0.25);
      expect(biasedIndex).toBeGreaterThanOrEqual(0);
      expect(zBiasValues.slice(biasedIndex + 1)).toContain(0);
    });

    it('does not push a global 0.0005 transparent z-bias into any uniform', () => {
      renderer.render(frame);
      const uniform1fCalls = vi.mocked(mockGL.uniform1f).mock.calls;
      const hasGlobalZBias = uniform1fCalls.some(([, value]) => value === 0.0005);
      expect(hasGlobalZBias).toBe(false);
    });
  });

  describe('dispose', () => {
    it('cleans up resources', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      expect(() => renderer.dispose()).not.toThrow();
      expect(renderer.getFeatures()).toBeNull();
    });

    it('can be called multiple times safely', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.dispose();
      expect(() => renderer.dispose()).not.toThrow();
    });
  });

  describe('texture state lifecycle', () => {
    it('resize preserves texture state', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());

      expect(renderer.getTextureArrayManager()).not.toBeNull();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();

      renderer.resize({ width: 1024, height: 768, dpr: 1 });

      expect(renderer.getTextureArrayManager()).not.toBeNull();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();
    });

    it('dispose destroys texture state', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());

      expect(renderer.getTextureArrayManager()).not.toBeNull();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();

      renderer.dispose();

      expect(renderer.getTextureArrayManager()).toBeNull();
    });

    it('dispose then init does not restore textures', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());

      expect(renderer.getTextureArrayManager()).not.toBeNull();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();

      renderer.dispose();
      renderer.init(canvas);

      expect(renderer.getTextureArrayManager()).toBeNull();
    });

    it('multiple resizes preserve texture state', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());

      renderer.resize({ width: 640, height: 360, dpr: 1 });
      renderer.resize({ width: 800, height: 600, dpr: 1 });
      renderer.resize({ width: 1280, height: 720, dpr: 1 });
      renderer.resize({ width: 1920, height: 1080, dpr: 1 });
      renderer.resize({ width: 1536, height: 864, dpr: 1 });

      expect(renderer.getTextureArrayManager()).not.toBeNull();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();
    });

    it('uploads per-layer texture scroll animations packed two layers per vec4', () => {
      const animations = new Map<number, [number, number]>([
        [40, [0, -2]],
        [59, [0, -1]],
      ]);
      const textureLoader: TextureLoader = {
        ...createMockTextureLoader(),
        getTextureIds: () => [7, 40, 59],
        getAnimationUv: (id: number) => animations.get(id) ?? [0, 0],
      };

      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(textureLoader);

      const uploads = vi
        .mocked(mockGL.uniform4fv)
        .mock.calls.filter(
          ([location]) => (location as unknown as { name: string })?.name === 'u_textureAnimations[0]',
        );
      expect(uploads.length).toBeGreaterThan(0);

      const packed = uploads[uploads.length - 1][1] as Float32Array;
      // Layer 0 is the white placeholder, so texture 7 -> layer 1, 40 -> 2, 59 -> 3.
      // Layer L lives at packed[(L >> 1) * 4 + (L & 1) * 2].
      expect(Array.from(packed.slice(0, 8))).toEqual([0, 0, 0, 0, 0, -2, 0, -1]);
    });

    it("keeps layer 0's animation slot zero through a load, a reload and a context restore", () => {
      const loaderWith = (ids: number[], animations: Map<number, [number, number]>): TextureLoader => ({
        ...createMockTextureLoader(),
        getTextureIds: () => ids,
        getAnimationUv: (id: number) => animations.get(id) ?? [0, 0],
      });
      const uploads = () =>
        vi
          .mocked(mockGL.uniform4fv)
          .mock.calls.filter(
            ([location]) => isMockUniformLocation(location) && location.name === 'u_textureAnimations[0]',
          )
          .map(([, value]) => value as Float32Array);
      // The table is uploaded by reference: read it when it is current.
      const latest = () => Array.from(uploads().at(-1) ?? []);

      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      // The first real texture is layer 1: it shares vec4 0 with the placeholder, in .zw.
      renderer.loadTextures(
        loaderWith(
          [7, 40, 59],
          new Map([
            [7, [4, -7]],
            [40, [0, -2]],
          ]),
        ),
      );
      const first = latest();
      expect(first).toHaveLength(512);
      expect(first.slice(0, 8)).toEqual([0, 0, 4, -7, 0, -2, 0, 0]);
      expect(first.slice(8).every((value) => value === 0)).toBe(true);

      // Different metadata: layer 1 now static, layer 2 another texture; nothing stale survives.
      renderer.loadTextures(loaderWith([9, 7], new Map([[7, [-3, 5]]])));
      const reloaded = latest();
      expect(reloaded.slice(0, 8)).toEqual([0, 0, 0, 0, -3, 5, 0, 0]);
      expect(reloaded.slice(8).every((value) => value === 0)).toBe(true);

      // The rebuilt programs get the same table, its layer 0 slot still zero.
      vi.mocked(mockGL.uniform4fv).mockClear();
      loseContext(canvas);
      restoreContext(canvas);
      expect(renderer.getContextStatus().kind).toBe('ok');
      expect(uploads().length).toBeGreaterThanOrEqual(2);
      for (const upload of uploads()) expect(Array.from(upload)).toEqual(reloaded);
      renderer.dispose();
    });

    describe('texture animation lookup', () => {
      /** The helper both scene vertex shaders carry, exactly. */
      const HELPER = [
        'vec2 textureAnimationOffset(int layer) {',
        '    int lookupLayer =',
        '        (layer > 0 && layer < TEXTURE_ANIM_MAX_LAYERS) ? layer : 0;',
        '    vec4 layerPair = u_textureAnimations[lookupLayer >> 1];',
        '    vec2 anim = (lookupLayer & 1) == 0 ? layerPair.xy : layerPair.zw;',
        '    return u_textureAnimTime * anim * TEXTURE_ANIM_UNIT;',
        '}',
      ].join('\n');
      const helperOf = (source: string) => {
        const start = source.indexOf('vec2 textureAnimationOffset(');
        return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
      };

      // CPU models of the helper in float32. `candidate` is HELPER statement for statement;
      // `previous` is the helper it replaced, which returned early outside 1..255.
      const f = Math.fround;
      const UNIT = f(1 / 128);
      const lanes = (table: Float32Array, layer: number) => {
        const base = (layer >> 1) * 4 + (layer & 1) * 2;
        return [table[base], table[base + 1]];
      };
      const scaled = (time: number, [u, v]: number[]) => [f(f(time * u) * UNIT), f(f(time * v) * UNIT)];
      const previous = (table: Float32Array, layer: number, time: number) =>
        layer <= 0 || layer >= 256 ? [0, 0] : scaled(time, lanes(table, layer));
      const candidate = (table: Float32Array, layer: number, time: number) => {
        const lookupLayer = layer > 0 && layer < 256 ? layer : 0;
        return scaled(time, lanes(table, lookupLayer));
      };

      /** The table the renderer uploads for these per-layer animations (layer L is texture L - 1). */
      const uploadedTable = (perLayer: (layer: number) => [number, number], layers: number) => {
        const ids = Array.from({ length: layers }, (_, index) => 5000 + index);
        const renderer = new PicoGLRenderer();
        renderer.init(canvas);
        renderer.resize(createMockViewport());
        vi.mocked(mockGL.uniform4fv).mockClear();
        renderer.loadTextures({
          ...createMockTextureLoader(),
          getTextureIds: () => ids,
          getAnimationUv: (id: number) => perLayer(id - 5000 + 1),
        });
        expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();
        const upload = vi
          .mocked(mockGL.uniform4fv)
          .mock.calls.filter(
            ([location]) => isMockUniformLocation(location) && location.name === 'u_textureAnimations[0]',
          )
          .at(-1)?.[1] as Float32Array;
        const table = new Float32Array(upload);
        renderer.dispose();
        return table;
      };

      // Animated layers of the shipped cache (2752): [layer, u, v]. Layer 1 is static there.
      const SHIPPED: readonly (readonly [number, number, number])[] = [
        [18, 0, -2],
        [25, 0, -2],
        [35, 0, -2],
        [41, 0, -2],
        [56, 0, -2],
        [57, 0, -2],
        [59, 0, -1],
        ...[99, 105, 111].flatMap((start) => [1, 2, 3, 4, 5].map((u) => [start + u - 1, u, 0] as const)),
      ];
      const INT_MIN = -2147483648;
      const INT_MAX = 2147483647;
      const LAYERS = [
        INT_MIN,
        -256,
        -2,
        -1,
        0,
        ...Array.from({ length: 255 }, (_, index) => index + 1),
        256,
        257,
        INT_MAX,
      ];
      // Client cycles: zero, tiny, a fraction, just under the wrap, and the wrap back to zero.
      const TIMES = [0, 1e-6, 0.5, 63.37, 127.99, (2560 / 20) % 128].map(f);

      it('is the same in both scene vertex shaders, reading layer 0 for a layer outside 1..255', () => {
        for (const source of [sceneBaseVertSource, sceneEffectsVertSource]) {
          expect(helperOf(source)).toBe(HELPER);
          expect(source).toContain('#define TEXTURE_ANIM_MAX_LAYERS 256');
          expect(source).toContain('#define TEXTURE_ANIM_VEC4_COUNT 128');
          expect(source).toContain('#define TEXTURE_ANIM_UNIT (1.0 / 128.0)');
          expect(source).toContain('uniform vec4 u_textureAnimations[TEXTURE_ANIM_VEC4_COUNT];');
          expect(source.split('textureAnimationOffset(int(a_textureId))')).toHaveLength(2);
        }
        // One unconditional read, indexed and swizzled by the chosen layer only.
        expect(HELPER).not.toMatch(/return vec2\(0\.0\)|\bif\s*\(/);
        expect(HELPER).not.toMatch(/\blayer\s*(>>|&)/);
      });

      it('gives every layer the same offset as before while layer 0 stays zero', () => {
        const synthetic = (layer: number): [number, number] =>
          layer === 1 ? [4, -7] : [((layer * 7) % 11) - 5, ((layer * 5) % 9) - 4];
        const tables = {
          synthetic: uploadedTable(synthetic, 255),
          shipped: uploadedTable((layer) => {
            const entry = SHIPPED.find(([at]) => at === layer);
            return entry ? [entry[1], entry[2]] : [0, 0];
          }, 215),
        };
        // The shipped layers as the renderer packed them, layer 1 static and layer 0 zero.
        expect(lanes(tables.shipped, 18)).toEqual([0, -2]);
        expect(lanes(tables.shipped, 59)).toEqual([0, -1]);
        expect(lanes(tables.shipped, 115)).toEqual([5, 0]);
        expect(lanes(tables.synthetic, 1)).toEqual([4, -7]);
        for (let layer = 1; layer < 256; layer++) expect(lanes(tables.synthetic, layer)).toEqual(synthetic(layer));
        for (const [name, table] of Object.entries(tables)) {
          expect(lanes(table, 0), name).toEqual([0, 0]);
          for (const layer of LAYERS) {
            for (const time of TIMES) {
              const expected = previous(table, layer, time);
              expect(candidate(table, layer, time), `${name} layer ${layer} time ${time}`).toEqual(expected);
              if (layer <= 0 || layer >= 256) expect(expected).toEqual([0, 0]);
            }
          }
        }
        // Layer 1 really moves (odd lanes, negative V), and so does an even layer.
        expect(candidate(tables.synthetic, 1, f(127.99))).toEqual(scaled(f(127.99), [4, -7]));
        expect(candidate(tables.synthetic, 1, f(127.99)).every((value) => value !== 0)).toBe(true);
        expect(candidate(tables.synthetic, 2, f(63.37)).every((value) => value !== 0)).toBe(true);
      });

      it('depends on the zero layer 0 slot: any other value would move untextured vertices', () => {
        const table = new Float32Array(512);
        table.set([9, -9, 4, -7]);
        expect(previous(table, -1, f(63.37))).toEqual([0, 0]);
        expect(candidate(table, -1, f(63.37))).not.toEqual([0, 0]);
      });
    });

    it('feeds the animation clock as finite client cycles wrapped below 128', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      const frame = createMockRenderFrame();
      frame.queue.commands = [createTestMeshCommand()];
      const now = vi.spyOn(performance, 'now');
      // 20 ms client cycles: 127.995, a whole wrap, a tiny step and a large uptime.
      for (const ms of [0, 2559.9, 2560, 0.02, 1e13 + 7]) {
        now.mockReturnValue(ms);
        renderer.render(frame);
      }
      const times = getUniform1fValues(mockGL, 'u_textureAnimTime');
      expect(times.length).toBeGreaterThanOrEqual(5);
      for (const time of times) {
        expect(Number.isFinite(time)).toBe(true);
        expect(time).toBeGreaterThanOrEqual(0);
        expect(time).toBeLessThan(128);
      }
      expect(times).toContain(0);
      expect(times.some((time) => time > 127.99)).toBe(true);
      renderer.dispose();
    });

    it('clears texture state when texture upload fails', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      expect(renderer.getTextureArrayManager()?.getTextureArray()).not.toBeNull();

      renderer.loadTextures({
        ...createMockTextureLoader(),
        getTextureIds: () => Array.from({ length: 300 }, (_, index) => index),
      });

      expect(renderer.getTextureArrayManager()).toBeNull();
    });
  });

  describe('assets', () => {
    it('provides asset manager', () => {
      const renderer = new PicoGLRenderer();
      expect(renderer.assets).toBeDefined();
      expect(typeof renderer.assets.hasTexture2D).toBe('function');
      expect(typeof renderer.assets.hasMesh).toBe('function');
      expect(typeof renderer.assets.hasMaterial).toBe('function');
    });
  });

  describe('context release on dispose', () => {
    function withLoseContextExtension(): ReturnType<typeof vi.fn> {
      const loseContext = vi.fn();
      const getExtension = vi.mocked(mockGL.getExtension).getMockImplementation() as (name: string) => unknown;
      vi.mocked(mockGL.getExtension).mockImplementation(((name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext } : getExtension(name)) as never);
      return loseContext;
    }

    it('releases a detached canvas context once on dispose, without reporting it as a game loss', () => {
      vi.useFakeTimers();
      const release = withLoseContextExtension();
      const renderer = new PicoGLRenderer();
      const statuses: RenderStatus['kind'][] = [];
      renderer.subscribeContextStatus((status) => statuses.push(status.kind));
      renderer.init(canvas);

      renderer.dispose();
      // The browser's lost event for the released context reaches no listener.
      loseContext(canvas);
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS * 2);

      expect(release).toHaveBeenCalledOnce();
      expect(statuses).toEqual([]);
      vi.useRealTimers();
    });

    it('keeps the context of a canvas still in the page, so re-initializing it (StrictMode) works', () => {
      const release = withLoseContextExtension();
      document.body.append(canvas);
      try {
        const renderer = new PicoGLRenderer();
        renderer.init(canvas);
        renderer.dispose();
        renderer.init(canvas);

        expect(release).not.toHaveBeenCalled();
        expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
        renderer.dispose();
      } finally {
        canvas.remove();
      }
    });

    it('still finishes disposing when releasing the context throws', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.mocked(mockGL.getExtension).mockImplementation(((name: string) => {
        if (name === 'WEBGL_lose_context') throw new Error('extension unavailable');
        return null;
      }) as never);

      expect(() => renderer.dispose()).not.toThrow();
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
    });
  });

  describe('per-draw GL state', () => {
    /**
     * What every draw of the fixture below reads, and reference GL call counts for it. The reference
     * counts include redundant VAO binds and depth masks, so the renderer must stay at or under every
     * count and strictly under those two. `UPDATE_DRAW_STATE_GOLDEN=draws` (the file's `regenerate`
     * command) re-pins only the draws after a deliberate change in what they read, keeping the
     * reference counts; `=baseline` re-records both from this tree, re-pinning the reference counts.
     */
    const GOLDEN_PATH = resolve(__dirname, 'PicoGLRenderer.drawState.golden.json');

    interface DrawStateGolden {
      readonly about: string;
      readonly regenerate: string;
      readonly baselineCalls: Record<string, number>;
      /** Each draw's fields that differ from the draw before it; `null` for a field it lacks. */
      readonly draws: Record<string, string | null>[];
    }

    function deltaEncode(draws: readonly Record<string, string>[]): Record<string, string | null>[] {
      return draws.map((fields, index) => {
        const previous = draws[index - 1] ?? {};
        const delta: Record<string, string | null> = {};
        for (const field of new Set([...Object.keys(previous), ...Object.keys(fields)])) {
          if (fields[field] !== previous[field]) delta[field] = fields[field] ?? null;
        }
        return delta;
      });
    }

    function deltaDecode(deltas: readonly Record<string, string | null>[]): Record<string, string>[] {
      let current: Record<string, string> = {};
      return deltas.map((delta) => {
        current = { ...current };
        for (const [field, value] of Object.entries(delta)) {
          if (value === null) delete current[field];
          else current[field] = value;
        }
        return current;
      });
    }

    /** One draw's recorded state as flat fields; long values (vertex data, big uniforms) as digests. */
    function drawFields(draw: string): Record<string, string> {
      const fields: Record<string, string> = {};
      const add = (path: string, value: unknown) => {
        const text = JSON.stringify(value);
        fields[path] =
          text.length <= 48 ? text : `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
      };
      for (const [key, value] of Object.entries(JSON.parse(draw) as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [field, inner] of Object.entries(value)) add(`${key}.${field}`, inner);
        } else {
          add(key, value);
        }
      }
      return fields;
    }

    /** Every differing field of every draw, decoded: which draw, which field, expected and actual. */
    function drawDifferences(actual: string[], expected: readonly Record<string, string>[]): string[] {
      const differences: string[] = [];
      for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
        const raw = actual[index];
        const fields = raw === undefined ? {} : drawFields(raw);
        const pinned = expected[index] ?? {};
        const label = `draw ${index} (${JSON.parse(fields.call ?? pinned.call ?? 'null')} of ${fields.count ?? pinned.count})`;
        for (const field of new Set([...Object.keys(pinned), ...Object.keys(fields)])) {
          if (fields[field] === pinned[field]) continue;
          const decoded =
            raw === undefined
              ? undefined
              : JSON.stringify(
                  field
                    .split('.')
                    .reduce<unknown>(
                      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
                      JSON.parse(raw),
                    ),
                );
          differences.push(`${label} ${field}: pinned ${pinned[field]}, now ${decoded?.slice(0, 120)}`);
        }
      }
      return differences;
    }

    function float32(length: number, seed: number, scale = 1): Float32Array {
      return new Float32Array(length).map((_, index) => ((seed * 37 + index * 11) % 97) * scale - 13);
    }

    function translated(x: number, y: number, z: number): Float32Array {
      const matrix = createIdentityMatrix();
      matrix.set([x, y, z], 12);
      return matrix;
    }

    function embedded(meshId: string, vertexCount: number, seed: number, extra: Partial<NpcMesh3DCommand> = {}) {
      return {
        kind: 'mesh3d',
        meshId,
        materialId: 'osrs-npc',
        modelMatrix: translated(seed, -seed / 2, seed * 3),
        positions: float32(vertexCount * 3, seed),
        perVertexHslColors: float32(vertexCount, seed + 1, 10),
        perVertexAlphas: new Float32Array(vertexCount).fill(1),
        perVertexFaceBias: float32(vertexCount, seed + 2),
        ...extra,
      } satisfies NpcMesh3DCommand as NpcMesh3DCommand;
    }

    /** An index-drawn mesh re-uploaded on every draw, as a fully sorted transparent spotanim part is. */
    function resorted(vertexCount: number, seed: number, z: number): NpcMesh3DCommand {
      return embedded('spotanim-9-frame-0-transparent-sorted', vertexCount, seed, {
        animated: true,
        depth: 'read',
        blend: 'normal',
        modelMatrix: translated(0, 0, z),
        perVertexAlphas: new Float32Array(vertexCount).fill(0.5),
        indices: new Uint16Array(vertexCount).map((_, index) => vertexCount - 1 - index),
      } as Partial<NpcMesh3DCommand>);
    }

    function indexedEffect(z: number): NpcMesh3DCommand {
      return embedded('fx-indexed', 6, 16, {
        depth: 'read',
        blend: 'normal',
        modelMatrix: translated(0, 0, z),
        indices: new Uint16Array([0, 2, 1, 3, 5, 4]),
      } as Partial<NpcMesh3DCommand>);
    }

    /** A frame whose camera gives every draw a distinct, non-degenerate transform. */
    function cameraFrame(): RenderFrame {
      const view = new Float32Array([0.9, 0.1, -0.3, 0, -0.2, 0.8, 0.4, 0, 0.35, -0.45, 0.7, 0, 5, -7, -30, 1]);
      const projection = new Float32Array([1.2, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, 0.001, -1, 0, 0, 0.5, 0]);
      const frame = createMockRenderFrame();
      const camera = frame.camera;
      if (camera.kind !== '3d') throw new Error('Expected a 3D camera');
      frame.camera = {
        kind: '3d',
        camera: { ...camera.camera, viewMatrix: () => view, projectionMatrix: () => projection },
      };
      return frame;
    }

    function scenerySource(): ImmutableMeshSource {
      const build = (): MeshUploadData[] => [
        { positions: float32(9, 1), perVertexHslColors: float32(3, 2, 10) },
        { positions: float32(18, 3), perVertexHslColors: float32(6, 4, 10), perVertexFaceBias: float32(6, 5) },
      ];
      return new ImmutableMeshSource('scenery', build(), build);
    }

    /** A renderer on its own recorded context, as `init` and `resize` leave it. */
    function recordedRenderer() {
      const gl = createComprehensiveMockGL();
      const target = document.createElement('canvas');
      vi.spyOn(target, 'getContext').mockReturnValue(gl);
      const recorder = recordGlDrawState(gl);
      const renderer = new PicoGLRenderer();
      renderer.init(target);
      renderer.resize(createMockViewport());
      return { gl, recorder, renderer, target };
    }

    /**
     * A recorded renderer whose rewrites always upload every attribute, as one without the
     * unchanged-upload skip would: each rewrite first forgets the copies the skip compares with.
     */
    function fullUploadRenderer() {
      const reference = recordedRenderer();
      const rewrite = reference.renderer['rewriteMeshVao'].bind(reference.renderer);
      reference.renderer['rewriteMeshVao'] = (gl, cached, cmd, resized) => {
        for (const slot of cached.slots) slot.contents = undefined;
        rewrite(gl, cached, cmd, resized);
      };
      return reference;
    }

    /** The raw bytes every buffer of `meshId`'s VAO holds, over its whole storage, as the recorder keeps them. */
    function storedBytes({ renderer }: ReturnType<typeof recordedRenderer>, meshId: string): number[][] {
      const cached = renderer['meshVaoCache'].get(meshId);
      if (!cached) throw new Error(`No VAO for ${meshId}`);
      return cached.slots.map((slot) => Array.from((slot.buffer as unknown as { storage: Uint8Array }).storage));
    }

    /** The draws `renderer` records for one frame of `commands`. */
    function recordFrame(
      { recorder, renderer }: ReturnType<typeof recordedRenderer>,
      commands: Mesh3DCommand[],
    ): string[] {
      const first = recorder.draws.length;
      const frame = cameraFrame();
      frame.queue.commands = commands;
      renderer.render(frame);
      return recorder.draws.slice(first);
    }

    /**
     * Every kind of draw the passes issue, in runs that repeat a VAO and runs that change it: a resident
     * source uploaded mid-frame, static and posed meshes, the cull-face exceptions, the sorted player
     * with its depth-only pass, transparent draws that do and do not write depth, an indexed mesh
     * re-uploaded draw after draw (growing once), a scene-effects draw, a no-depth overlay and, when
     * `rebuild` is set, a posed mesh whose layout change deletes the VAO the previous draw left bound.
     */
    function frameCommands(source: ImmutableMeshSource, frame: number, rebuild: boolean): Mesh3DCommand[] {
      const resident = (part: number, x: number): ResidentMesh3DCommand => ({
        kind: 'mesh3d',
        meshId: `scenery-${part}`,
        materialId: 'osrs-npc',
        modelMatrix: translated(x, 0, 0),
        meshSource: source,
        meshSourcePart: part,
      });
      const posed = embedded('npc-1-opaque', 6, 40 + frame, { animated: true });
      return [
        resident(0, 1),
        resident(0, 2),
        resident(1, 3),
        embedded('rock', 3, 7),
        embedded('rock', 3, 8),
        embedded('rock', 3, 9, { cullFace: 'none' }),
        embedded('rock', 3, 10, { cullFace: 'front' }),
        posed,
        ...(rebuild ? [embedded('npc-1-opaque', 9, 50 + frame, { animated: true, uvs: float32(18, 3, 0.01) })] : []),
        embedded('player-model', 6, 20 + frame, { animated: true, depth: 'sorted' }),
        embedded('fx-a', 3, 11, { depth: 'read', blend: 'normal', modelMatrix: translated(0, 0, 40) }),
        embedded('fx-a', 3, 11, { depth: 'read', blend: 'normal', modelMatrix: translated(0, 0, 39) }),
        embedded('fx-b', 3, 12, { depth: 'readwrite', blend: 'normal', modelMatrix: translated(0, 0, 38) }),
        // Drawn just before a re-upload and again after it: its index binding must survive the upload.
        indexedEffect(31),
        resorted(6, 60 + frame, 30),
        resorted(6, 61 + frame, 29),
        resorted(12, 62 + frame, 28),
        embedded('fx-a', 3, 11, { depth: 'read', blend: 'normal', modelMatrix: translated(0, 0, 27) }),
        embedded('lobby-glow', 3, 13, {
          shaderId: 'scene-effects',
          normals: float32(9, 14),
          uniforms: { u_animParams: [1, 2, 3, 4] },
          depth: 'read',
          blend: 'normal',
          modelMatrix: translated(0, 0, 26),
        }),
        indexedEffect(25),
        embedded('overlay', 3, 15, { depth: 'none' }),
      ];
    }

    it('hands every draw the golden state and vertices, with fewer calls than the recorded baseline', () => {
      vi.useFakeTimers();
      try {
        const recorder = recordGlDrawState(mockGL);
        const renderer = new PicoGLRenderer();
        renderer.init(canvas);
        renderer.resize(createMockViewport());
        const frame = cameraFrame();
        const source = scenerySource();

        recorder.recording = true;
        for (const [index, step] of ['plain', 'rebuild', 'context lost', 'plain', 'rebuild'].entries()) {
          if (step === 'context lost') {
            loseContext(canvas);
            recorder.resetContext();
            restoreContext(canvas);
            continue;
          }
          frame.queue.commands = frameCommands(source, index, step === 'rebuild');
          renderer.render(frame);
        }
        recorder.recording = false;
        renderer.dispose();

        expect(recorder.errors).toEqual([]);
        const calls = Object.fromEntries([...recorder.calls].sort(([a], [b]) => a.localeCompare(b)));
        const update = process.env.UPDATE_DRAW_STATE_GOLDEN;
        if (update === 'baseline' || update === 'draws') {
          const previous =
            update === 'draws' ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as DrawStateGolden) : null;
          const golden: DrawStateGolden = {
            about:
              previous?.about ??
              'What each draw of the per-draw GL state fixture in PicoGLRenderer.test.ts reads (decoded fields, long values as digests, each draw as its change from the one before), and the GL calls the renderer made for it.',
            regenerate:
              'UPDATE_DRAW_STATE_GOLDEN=draws npx vitest run src/render/backends/picogl/PicoGLRenderer.test.ts -t "per-draw GL state"',
            baselineCalls: previous?.baselineCalls ?? calls,
            draws: deltaEncode(recorder.draws.map(drawFields)),
          };
          writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`);
          // Recorded from the reference renderer: there is nothing to compare it with here.
          if (update === 'baseline') return;
        }
        const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as DrawStateGolden;

        expect(drawDifferences(recorder.draws, deltaDecode(golden.draws)).slice(0, 20)).toEqual([]);
        // Draw calls may only drop redundant work against the reference counts. The single
        // restoration is allowed one `isContextLost` safety check beyond them.
        for (const [name, count] of Object.entries(calls)) {
          const restoreSafetyChecks = name === 'isContextLost' ? 1 : 0;
          expect(count, name).toBeLessThanOrEqual((golden.baselineCalls[name] ?? 0) + restoreSafetyChecks);
        }
        expect(calls.bindVertexArray).toBeLessThan(golden.baselineCalls.bindVertexArray ?? 0);
        expect(calls.depthMask).toBeLessThan(golden.baselineCalls.depthMask ?? 0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reads what a full upload would, through skipped uploads, a shared sorted VAO and a pose that changes, holds and returns', () => {
      vi.useFakeTimers();
      try {
        const persistent = recordedRenderer();
        const reference = fullUploadRenderer();
        // Pose seeds per frame: held, changed, held, back to the first, then a larger pose.
        const poses = [
          { seed: 1, vertices: 6 },
          { seed: 1, vertices: 6 },
          { seed: 2, vertices: 6 },
          { seed: 2, vertices: 6 },
          { seed: 1, vertices: 6 },
          { seed: 3, vertices: 9 },
          { seed: 3, vertices: 9 },
        ];
        const commandsFor = (pose: (typeof poses)[number]) => [
          embedded('npc-1-opaque', pose.vertices, 40 + pose.seed, { animated: true }),
          // Two instances of one effect re-upload through the same sorted VAO, one after the other.
          resorted(6, 60, 30),
          resorted(6, 61, 29),
        ];
        const attributes = (draws: string[]) => draws.map((draw) => JSON.parse(draw).attributes);
        const uploadedBytes: number[] = [];
        for (const [index, pose] of poses.entries()) {
          const before = vi.mocked(persistent.gl.bufferSubData).mock.calls.length;
          const actual = recordFrame(persistent, commandsFor(pose));
          const subData = vi.mocked(persistent.gl.bufferSubData).mock.calls.slice(before);
          uploadedBytes.push(subData.reduce((sum, [, , data]) => sum + (data as ArrayBufferView).byteLength, 0));
          const expected = recordFrame(reference, commandsFor(pose));
          expect(attributes(actual), `frame ${index}`).toEqual(attributes(expected));
        }
        expect(persistent.recorder.errors).toEqual([]);
        expect(reference.recorder.errors).toEqual([]);
        // The shared sorted VAO alternates between its two instances every draw, so it uploads
        // their differing attributes each frame; the pose uploads only when it changes.
        const effectsOnly = uploadedBytes[1] ?? 0;
        expect(effectsOnly).toBeGreaterThan(0);
        expect(uploadedBytes[3]).toBe(effectsOnly);
        expect(uploadedBytes[6]).toBe(effectsOnly);
        expect(uploadedBytes[2]).toBeGreaterThan(effectsOnly);
        expect(uploadedBytes[4]).toBeGreaterThan(effectsOnly);
        expect(uploadedBytes[5]).toBeGreaterThan(effectsOnly);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('indexed immutable soups', () => {
      /** A quad as two triangles, corners 0 1 2 and 2 1 3, each corner its own soup vertex. */
      function quadSoup(meshId: string, extra: Partial<NpcMesh3DCommand> = {}): NpcMesh3DCommand {
        return {
          kind: 'mesh3d',
          meshId,
          materialId: 'osrs-npc',
          modelMatrix: translated(1, 2, 3),
          positions: new Float32Array([0, 0, 0, 64, 0, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 64, 0, 64]),
          perVertexHslColors: new Float32Array([10, 11, 12, 12, 11, 13]),
          perVertexAlphas: new Float32Array([1, 0.5, 1, 1, 0.5, 1]),
          perVertexFaceBias: new Float32Array([0, 3, 0, 0, 3, 7]),
          ...extra,
        };
      }

      /** What a draw read at the given locations, corner by corner. */
      function readAt(draw: string, locations: readonly number[]): unknown[] {
        const { attributes } = JSON.parse(draw);
        return locations.map((location) => attributes[location]);
      }

      /**
       * The soup the command handed over, at the same locations, as the recorder's JSON shows it (which
       * loses the sign of zero; {@link expandedBits} compares raw bits).
       */
      function soupAt(command: NpcMesh3DCommand, locations: readonly number[]): unknown[] {
        const arrays: Record<number, Float32Array | undefined> = {
          0: command.positions,
          1: command.normals,
          4: command.perVertexHslColors,
          6: command.perVertexAlphas,
          7: command.perVertexFaceBias,
        };
        return JSON.parse(JSON.stringify(locations.map((location) => Array.from(arrays[location] ?? []))));
      }

      /** Every uploaded attribute of a cached VAO, fetched through its index buffer, as raw bits. */
      function expandedBits(cached: unknown): Record<string, number[]> {
        const { slots } = cached as { slots: { attribute: string; buffer: unknown }[] };
        const storage = (buffer: unknown) => (buffer as { storage: Uint8Array }).storage;
        const indexSlot = slots.find((slot) => slot.attribute === 'indices');
        if (!indexSlot) throw new Error('Expected an index buffer');
        const indexBytes = storage(indexSlot.buffer);
        const indices = Array.from(
          new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 2),
        );
        const expanded: Record<string, number[]> = {};
        for (const slot of slots) {
          if (slot.attribute === 'indices') continue;
          const bytes = storage(slot.buffer);
          const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          const size =
            slot.attribute === 'positions' || slot.attribute === 'normals' ? 3 : slot.attribute === 'uvs' ? 2 : 1;
          expanded[slot.attribute] = indices.flatMap((index) =>
            Array.from(words.subarray(index * size, index * size + size)),
          );
        }
        return expanded;
      }

      const bits = (data: Float32Array) => Array.from(new Uint32Array(data.buffer, data.byteOffset, data.length));

      it('draws an indexed static soup with 16-bit indices at offset 0, reading every corner in order', () => {
        vi.useFakeTimers();
        try {
          const harness = recordedRenderer();
          const quad = quadSoup('quad');
          const [draw] = recordFrame(harness, [quad]);
          const recorded = JSON.parse(draw ?? 'null');

          expect(harness.recorder.errors).toEqual([]);
          expect([recorded.call, recorded.count, recorded.type, recorded.offset]).toEqual([
            'drawElements',
            6,
            harness.gl.UNSIGNED_SHORT,
            0,
          ]);
          expect(readAt(draw ?? '', [0, 4, 6, 7])).toEqual(soupAt(quad, [0, 4, 6, 7]));
          const cached = harness.renderer['meshVaoCache'].get('quad');
          expect(cached?.vertexCount).toBe(4);
          const expanded = expandedBits(cached);
          expect(expanded.positions).toEqual(bits(quad.positions));
          expect(expanded.perVertexFaceBias).toEqual(bits(quad.perVertexFaceBias!));
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps corners apart that differ in an attribute only some programs upload, and in the sign of zero', () => {
        vi.useFakeTimers();
        try {
          const harness = recordedRenderer();
          // Corners 1 and 4 match in every scene-base attribute but differ in their normals, which
          // scene-effects uploads; corners 2 and 3 differ only in their face bias, +0 against -0.
          const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0]);
          const base = quadSoup('quad');
          base.perVertexFaceBias = new Float32Array([0, 3, 0, -0, 3, 7]);
          const effects = quadSoup('quad-effects', { shaderId: 'scene-effects', normals });
          const draws = recordFrame(harness, [base, effects]);

          expect(harness.recorder.errors).toEqual([]);
          expect(readAt(draws[0] ?? '', [0, 4, 6, 7])).toEqual(soupAt(base, [0, 4, 6, 7]));
          expect(readAt(draws[1] ?? '', [0, 1, 4, 6, 7])).toEqual(soupAt(effects, [0, 1, 4, 6, 7]));
          const cache = harness.renderer['meshVaoCache'];
          expect(cache.get('quad')?.vertexCount).toBe(5);
          expect(expandedBits(cache.get('quad')).perVertexFaceBias).toEqual(bits(base.perVertexFaceBias));
          expect(cache.get('quad-effects')?.vertexCount).toBe(5);
          expect(expandedBits(cache.get('quad-effects')).normals).toEqual(bits(normals));
        } finally {
          vi.useRealTimers();
        }
      });

      it('rebuilds a static indexed VAO for an animated soup of the same vertex count under its mesh id', () => {
        vi.useFakeTimers();
        try {
          const harness = recordedRenderer();
          // Twelve corners that index down to six vertices, then a six-corner animated soup.
          const quad = quadSoup('shared', { positions: new Float32Array(18).map((_, index) => index) });
          const twice = (data: Float32Array) => new Float32Array([...data, ...data]);
          const doubled = {
            ...quad,
            positions: twice(quad.positions),
            perVertexHslColors: twice(quad.perVertexHslColors!),
            perVertexAlphas: twice(quad.perVertexAlphas!),
            perVertexFaceBias: twice(quad.perVertexFaceBias!),
          };
          recordFrame(harness, [doubled]);
          expect(harness.renderer['meshVaoCache'].get('shared')?.vertexCount).toBe(6);
          const animated = quadSoup('shared', {
            animated: true,
            positions: new Float32Array(18).map((_, index) => index * 2),
          });
          const [draw] = recordFrame(harness, [animated]);

          expect(harness.recorder.errors).toEqual([]);
          expect([JSON.parse(draw ?? 'null').call, JSON.parse(draw ?? 'null').count]).toEqual(['drawArrays', 6]);
          expect(readAt(draw ?? '', [0, 4, 6, 7])).toEqual(soupAt(animated, [0, 4, 6, 7]));
        } finally {
          vi.useRealTimers();
        }
      });

      it('indexes a resident source the same way on its first upload and on the rebuild after a context restore', () => {
        vi.useFakeTimers();
        try {
          const harness = recordedRenderer();
          const build = (): MeshUploadData[] => {
            const quad = quadSoup('unused');
            return [
              {
                positions: quad.positions,
                perVertexHslColors: quad.perVertexHslColors,
                perVertexAlphas: quad.perVertexAlphas,
                perVertexFaceBias: quad.perVertexFaceBias,
              },
            ];
          };
          const source = new ImmutableMeshSource('indexed-scenery', build(), build);
          const command: ResidentMesh3DCommand = {
            kind: 'mesh3d',
            meshId: 'indexed-scenery-0',
            materialId: 'osrs-npc',
            modelMatrix: translated(1, 2, 3),
            meshSource: source,
            meshSourcePart: 0,
          };
          const expected = soupAt(quadSoup('unused'), [0, 4, 6, 7]);
          const first = recordFrame(harness, [command]);
          const firstPart = harness.renderer['residentSources'].get(source.id)?.parts[0];
          const firstBits = expandedBits(firstPart);

          loseContext(harness.target);
          harness.recorder.resetContext();
          restoreContext(harness.target);
          const restored = recordFrame(harness, [command]);
          const restoredPart = harness.renderer['residentSources'].get(source.id)?.parts[0];

          expect(harness.recorder.errors).toEqual([]);
          expect(restoredPart === firstPart).toBe(false);
          expect([first, restored].map((draws) => readAt(draws[0] ?? '', [0, 4, 6, 7]))).toEqual([expected, expected]);
          expect(JSON.parse(restored[0] ?? 'null').call).toBe('drawElements');
          expect(expandedBits(restoredPart)).toEqual(firstBits);
          expect(firstBits.positions).toEqual(bits(quadSoup('unused').positions));
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('draws an all +0 face bias from the 0.0 constant, keeps -0 and non-zero buffers, and switches between them', () => {
      vi.useFakeTimers();
      try {
        const harness = recordedRenderer();
        const FACE_BIAS = 7;
        const withFaceBias = (meshId: string, faceBias: Float32Array, extra: Partial<NpcMesh3DCommand> = {}) =>
          embedded(meshId, 3, 70, { perVertexFaceBias: faceBias, ...extra });
        const biased = withFaceBias('biased', new Float32Array([0, 3, 0]));
        const zero = withFaceBias('zero', new Float32Array(3));
        const negativeZero = withFaceBias('negative-zero', new Float32Array([0, -0, 0]));
        const animatedZero = withFaceBias('animated-zero', new Float32Array(3), { animated: true });
        // Every draw switches location 7 between a buffer and the constant.
        const draws = recordFrame(harness, [biased, zero, negativeZero, zero, biased, animatedZero, zero]);

        expect(harness.recorder.errors).toEqual([]);
        const faceBiasRead = draws.map((draw) => JSON.parse(draw).attributes[FACE_BIAS]);
        expect(faceBiasRead).toEqual([
          [0, 3, 0],
          { constant: [0, 0, 0, 1] },
          [0, 0, 0],
          { constant: [0, 0, 0, 1] },
          [0, 3, 0],
          [0, 0, 0],
          { constant: [0, 0, 0, 1] },
        ]);
        // The constant's x is what the shader's float a_faceBias reads: the same 0.0 the buffer held.
        const cache = harness.renderer['meshVaoCache'];
        expect(cache.get('zero')?.faceBiasBuffer).toBeUndefined();
        expect(cache.get('biased')?.faceBiasBuffer).toBeDefined();
        // The decoded draw loses the sign of zero, so check the -0 buffer's bytes themselves.
        const storage = (cache.get('negative-zero')?.faceBiasBuffer as unknown as { storage: Uint8Array } | undefined)
          ?.storage;
        expect(storage && Array.from(storage)).toEqual(
          Array.from(new Uint8Array(negativeZero.perVertexFaceBias!.buffer)),
        );
        // Animated meshes keep theirs: a later pose may not be zero.
        expect(cache.get('animated-zero')?.faceBiasBuffer).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves every buffer byte a full upload would: NaN payloads, negative zero, shrinking and regrowing', () => {
      vi.useFakeTimers();
      try {
        const [skipping, reference] = [recordedRenderer(), fullUploadRenderer()];
        const values = (vertexCount: number, seed: number) => float32(vertexCount * 3, seed);
        const mesh = (positions: Float32Array, faceBias: Float32Array) =>
          embedded('npc-1-opaque', positions.length / 3, 40, {
            animated: true,
            positions,
            perVertexHslColors: new Float32Array(positions.length / 3).fill(500),
            perVertexAlphas: new Float32Array(positions.length / 3).fill(1),
            perVertexFaceBias: faceBias,
          });
        const nan = (payload: number) => {
          const positions = values(6, 1);
          new DataView(positions.buffer).setUint32(4, payload, true);
          return positions;
        };
        const six = values(6, 1);
        const shorter = values(3, 2);
        // The first three vertices of `shorter`, then the tail `six` left in the buffer.
        const regrown = new Float32Array([...shorter, ...six.subarray(9, 15)]);
        const steps: { label: string; positions: Float32Array; faceBias: Float32Array; skipsPositions: boolean }[] = [
          { label: 'first', positions: six, faceBias: new Float32Array(6), skipsPositions: false },
          { label: 'quiet NaN', positions: nan(0x7fc00001), faceBias: new Float32Array(6), skipsPositions: false },
          {
            label: 'other NaN payload',
            positions: nan(0x7fc00002),
            faceBias: new Float32Array(6),
            skipsPositions: false,
          },
          { label: 'negative zero', positions: six, faceBias: new Float32Array(6).fill(-0), skipsPositions: false },
          { label: 'positive zero', positions: six, faceBias: new Float32Array(6), skipsPositions: true },
          {
            label: 'shrunk to a prefix',
            positions: six.slice(0, 9),
            faceBias: new Float32Array(3),
            skipsPositions: true,
          },
          { label: 'shorter overwrite', positions: shorter, faceBias: new Float32Array(3), skipsPositions: false },
          { label: 'regrown onto the tail', positions: regrown, faceBias: new Float32Array(5), skipsPositions: true },
          { label: 'regrown past it', positions: values(6, 3), faceBias: new Float32Array(6), skipsPositions: false },
        ];
        for (const step of steps) {
          const before = vi.mocked(skipping.gl.bufferSubData).mock.calls.length;
          recordFrame(skipping, [mesh(step.positions, step.faceBias)]);
          recordFrame(reference, [mesh(step.positions, step.faceBias)]);
          const uploaded = vi
            .mocked(skipping.gl.bufferSubData)
            .mock.calls.slice(before)
            .map(([, , data]) => data);
          expect(storedBytes(skipping, 'npc-1-opaque'), step.label).toEqual(storedBytes(reference, 'npc-1-opaque'));
          if (step.label !== 'first') {
            expect(uploaded.includes(step.positions), `${step.label} uploads positions`).toBe(!step.skipsPositions);
          }
          // Negative zero after zero, and zero after negative zero, are different bytes.
          if (step.label.endsWith('zero')) expect(uploaded, step.label).toContain(step.faceBias);
        }
        expect(skipping.recorder.errors).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('draws the next frame as an undisturbed renderer does after foreign code changes GL state between frames', () => {
      vi.useFakeTimers();
      try {
        const [undisturbed, disturbed] = [recordedRenderer(), recordedRenderer()];
        const [quietSource, noisySource] = [scenerySource(), scenerySource()];
        recordFrame(undisturbed, frameCommands(quietSource, 0, false));
        recordFrame(disturbed, frameCommands(noisySource, 0, false));

        // Between frames: PicoGL builds a mesh (binding its own VAO and index buffer, and leaving the
        // VAO bound), then raw code binds another VAO with an index buffer and clears the depth mask.
        disturbed.renderer.assets.ensureMesh('foreign', {
          positions: new Float32Array(9),
          indices: new Uint16Array([0, 1, 2]),
        });
        const { gl } = disturbed;
        gl.bindVertexArray(gl.createVertexArray());
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.depthMask(false);

        undisturbed.recorder.recording = true;
        disturbed.recorder.recording = true;
        const expected = recordFrame(undisturbed, frameCommands(quietSource, 1, true));
        const actual = recordFrame(disturbed, frameCommands(noisySource, 1, true));

        expect(disturbed.recorder.errors).toEqual([]);
        expect(actual.length).toBeGreaterThan(0);
        expect(drawDifferences(actual, expected.map(drawFields)).slice(0, 20)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('unbinds and forgets its state when a frame throws mid-draw, and draws the next frame correctly', () => {
      vi.useFakeTimers();
      try {
        const [undisturbed, failing] = [recordedRenderer(), recordedRenderer()];
        const [quietSource, failingSource] = [scenerySource(), scenerySource()];
        const start = () => [
          embedded('rock', 3, 7),
          embedded('fx-a', 3, 11, { depth: 'read', blend: 'normal', modelMatrix: translated(0, 0, 40) }),
        ];
        // Drawn after fx-a: reading its uniforms throws with fx-a's VAO bound, its depth mask off and
        // the effect's program in use.
        const poisoned = embedded('lobby-glow', 3, 13, {
          shaderId: 'scene-effects',
          normals: float32(9, 14),
          depth: 'read',
          blend: 'normal',
          modelMatrix: translated(0, 0, 26),
        });
        Object.defineProperty(poisoned, 'uniforms', {
          get: () => {
            throw new Error('poisoned command');
          },
        });
        recordFrame(undisturbed, start());
        expect(() => recordFrame(failing, [...start(), poisoned])).toThrow('poisoned command');
        expect(vi.mocked(failing.gl.bindVertexArray).mock.calls.at(-1)).toEqual([null]);

        undisturbed.recorder.recording = true;
        failing.recorder.recording = true;
        const expected = recordFrame(undisturbed, frameCommands(quietSource, 1, true));
        const actual = recordFrame(failing, frameCommands(failingSource, 1, true));

        expect(failing.recorder.errors).toEqual([]);
        expect(drawDifferences(actual, expected.map(drawFields)).slice(0, 20)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('routes every VAO bind and depth mask through the tracker, and draws through no PicoGL buffer or VAO call', () => {
      const program = parse(readFileSync(resolve(__dirname, 'PicoGLRenderer.ts'), 'utf-8'), {
        sourceType: 'module',
        plugins: ['typescript'],
      }).program;
      // PicoGL binds and unbinds VAOs behind these, which the tracker would not see.
      const picoglVaoCalls = new Set([
        'vertexAttributeBuffer',
        'instanceAttributeBuffer',
        'indexBuffer',
        'createVertexArray',
        'createVertexBuffer',
        'createIndexBuffer',
        'createMatrixBuffer',
        'createInterleavedBuffer',
        'data',
      ]);
      type Node = { type: string; loc?: { start: { line: number } } | null; [key: string]: unknown };
      const isNode = (value: unknown): value is Node =>
        typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
      const offences: string[] = [];
      const visit = (node: Node, method: string | null): void => {
        const key = node.key as Node | undefined;
        const inside = node.type === 'ClassMethod' && key?.type === 'Identifier' ? String(key.name) : method;
        const property = node.property as Node | undefined;
        if (node.type === 'MemberExpression' && property?.type === 'Identifier') {
          const name = String(property.name);
          const onThis = (node.object as Node).type === 'ThisExpression';
          const site = `${inside ?? '(top level)'}:${node.loc?.start.line} .${name}`;
          if (!onThis && name === 'bindVertexArray' && inside !== 'bindVertexArray') offences.push(site);
          if (!onThis && name === 'depthMask' && inside !== 'setDepthMask') offences.push(site);
          if (inside === 'drawPasses' && (picoglVaoCalls.has(name) || (onThis && name === 'app'))) offences.push(site);
        }
        for (const [field, value] of Object.entries(node)) {
          if (field === 'loc' || field === 'leadingComments' || field === 'trailingComments') continue;
          for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child, inside);
        }
      };
      visit(program as unknown as Node, null);

      expect(offences).toEqual([]);
    });
  });

  describe('scene boundary', () => {
    it('draws the next scene from fresh buffers when it reuses a mesh id, on the same context and textures', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      const textureArray = renderer.getTextureArrayManager()?.getTextureArray();
      const frame = createMockRenderFrame();
      // Every scene names its merged static LOCs the same way.
      const meshId = 'merged-static-locs-opaque';
      frame.queue.commands = [createTestMeshCommand({ meshId, positions: distinctFloats(9) })];
      renderer.render(frame);
      const firstVao = lastNonNullArg(vi.mocked(mockGL.bindVertexArray).mock.calls, 0);
      vi.mocked(canvas.getContext).mockClear();
      vi.mocked(mockGL.createProgram).mockClear();
      vi.mocked(mockGL.texStorage3D).mockClear();
      vi.mocked(mockGL.bufferData).mockClear();

      renderer.releaseSceneMeshes();
      const secondScene = distinctFloats(18).map((value) => value + 2);
      frame.queue.commands = [createTestMeshCommand({ meshId, positions: secondScene })];
      renderer.render(frame);

      expect(mockGL.deleteVertexArray).toHaveBeenCalledWith(firstVao);
      expect(lastNonNullArg(vi.mocked(mockGL.bindVertexArray).mock.calls, 0)).not.toBe(firstVao);
      expect(vi.mocked(mockGL.bufferData).mock.calls.some(([, data]) => data === secondScene)).toBe(true);
      expect(getDrawCounts(mockGL).at(-1)).toBe(6);
      // The context, programs and texture array are untouched.
      expect(canvas.getContext).not.toHaveBeenCalled();
      expect(mockGL.createProgram).not.toHaveBeenCalled();
      expect(mockGL.texStorage3D).not.toHaveBeenCalled();
      expect(renderer.getTextureArrayManager()?.getTextureArray()).toBe(textureArray);
    });
  });

  describe('resident mesh sources', () => {
    const ALPHA_LOCATION = 6;
    let frame: ReturnType<typeof createMockRenderFrame>;

    beforeEach(() => {
      frame = createMockRenderFrame();
    });

    /** A two-part source, opaque then translucent, whose every build is fresh arrays of the same values. */
    function twoPartBuild(): MeshUploadData[] {
      return [
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          perVertexHslColors: new Float32Array([100, 100, 100]),
        },
        {
          // Two triangles sharing no vertex, so the part uploads as the soup it is.
          positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 2, 1, 0, 2]),
          perVertexHslColors: new Float32Array(6).fill(200),
          perVertexAlphas: new Float32Array(6).fill(0.5),
        },
      ];
    }

    /** A source, the first build it hands over, and its (spied) rebuild. */
    function source(id = 'merged-static-locs', build = twoPartBuild, scope: MeshSourceScope = 'scene') {
      const rebuild = vi.fn(build);
      const firstBuild = build();
      return { source: new ImmutableMeshSource(id, firstBuild, rebuild, { scope }), rebuild, firstBuild };
    }

    function residentCommand(meshSource: ImmutableMeshSource, part: number, transparent = false): Mesh3DCommand {
      const command: ResidentMesh3DCommand = {
        kind: 'mesh3d',
        meshId: `${meshSource.id}-${part}`,
        materialId: 'osrs-npc',
        modelMatrix: createIdentityMatrix(),
        meshSource,
        meshSourcePart: part,
        ...(transparent ? { depth: 'read' as const, blend: 'normal' as const } : {}),
      };
      return command;
    }

    function initRenderer(
      options?: ConstructorParameters<typeof PicoGLRenderer>[0],
      init?: RendererInitOptions,
    ): PicoGLRenderer {
      const renderer = new PicoGLRenderer(options);
      renderer.init(canvas, init);
      renderer.resize(createMockViewport());
      vi.clearAllMocks();
      return renderer;
    }

    function render(renderer: PicoGLRenderer, ...commands: Mesh3DCommand[]): void {
      frame.queue.commands = commands;
      renderer.render(frame);
    }

    function uploads(): unknown[] {
      return vi.mocked(mockGL.bufferData).mock.calls.map(([, data]) => data);
    }

    it('uploads the first build once, with the attribute layout an embedded batch gets, and draws every part', () => {
      const renderer = initRenderer();
      const { source: scenery, rebuild, firstBuild: first } = source();

      render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));
      render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));

      expect(rebuild).not.toHaveBeenCalled();
      // Positions and colors of both parts, plus the translucent part's alphas; the opaque part has none.
      expect(uploads()).toEqual([
        first[0]!.positions,
        first[0]!.perVertexHslColors,
        first[1]!.positions,
        first[1]!.perVertexHslColors,
        first[1]!.perVertexAlphas,
      ]);
      for (const data of uploads()) expect(first.flatMap((part) => Object.values(part))).toContain(data);
      expect(
        vi.mocked(mockGL.vertexAttribPointer).mock.calls.filter(([location]) => location === ALPHA_LOCATION),
      ).toHaveLength(1);
      expect(mockGL.createVertexArray).toHaveBeenCalledTimes(2);
      expect(getDrawCounts(mockGL)).toEqual([3, 6, 3, 6]);
      // The source no longer holds the arrays it handed over.
      expect(scenery.holdsFirstBuild).toBe(false);
      expect(renderer['residentSourceBytes']).toBe(
        uploads().reduce<number>((sum, data) => sum + (data as Float32Array).byteLength, 0),
      );
    });

    it('draws nothing for an empty part', () => {
      const renderer = initRenderer();
      const { source: scenery } = source('empty-transparent', () => [
        { positions: distinctFloats(9), perVertexHslColors: new Float32Array(3) },
        { positions: new Float32Array(0), perVertexHslColors: new Float32Array(0) },
      ]);
      render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));
      expect(getDrawCounts(mockGL)).toEqual([3]);
      expect(mockGL.createVertexArray).toHaveBeenCalledOnce();
    });

    it('is exempt from the stale-frame eviction that embedded meshes get', () => {
      const renderer = initRenderer();
      const { source: scenery, rebuild } = source();
      render(renderer, residentCommand(scenery, 0));
      for (let i = 0; i < 300; i++) render(renderer, createTestMeshCommand());
      vi.clearAllMocks();

      render(renderer, residentCommand(scenery, 0));

      expect(rebuild).not.toHaveBeenCalled();
      expect(mockGL.deleteVertexArray).not.toHaveBeenCalled();
      expect(getDrawCounts(mockGL)).toEqual([3]);
    });

    it('rebuilds once per source after a context loss, for all of its parts, with the same bytes', () => {
      vi.useFakeTimers();
      try {
        const renderer = initRenderer();
        const { source: scenery, rebuild } = source();
        render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));
        const firstUpload = uploads().map((data) => Array.from(data as Float32Array));

        loseContext(canvas);
        restoreContext(canvas);
        vi.clearAllMocks();
        render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));

        expect(rebuild).toHaveBeenCalledOnce();
        expect(uploads().map((data) => Array.from(data as Float32Array))).toEqual(firstUpload);
        expect(getDrawCounts(mockGL)).toEqual([3, 6]);
        expect(mockGL.deleteVertexArray).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases every source at the scene boundary and on dispose, rebuilding on the next draw', () => {
      const renderer = initRenderer();
      const { source: scenery, rebuild } = source();
      render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true));

      renderer.releaseSceneMeshes();
      expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(2);
      expect(renderer['residentSourceBytes']).toBe(0);
      render(renderer, residentCommand(scenery, 0));
      expect(rebuild).toHaveBeenCalledOnce();

      renderer.dispose();
      expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(4);
      expect(renderer['residentSources'].size).toBe(0);
    });

    it('replaces a resident source when a different one arrives under its id', () => {
      const renderer = initRenderer();
      const { source: smooth } = source('terrain-0-0-level-0');
      render(renderer, residentCommand(smooth, 0));
      const { source: flat, rebuild } = source('terrain-0-0-level-0');
      render(renderer, residentCommand(flat, 0));

      expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(2);
      expect(renderer['residentSources'].get('terrain-0-0-level-0')?.source).toBe(flat);
      expect(rebuild).not.toHaveBeenCalled();
      expect(getDrawCounts(mockGL)).toEqual([3, 3]);
    });

    it('over budget, releases the least recently drawn sources between frames, never one drawn this frame', () => {
      // Each source is one 3-vertex part with positions (36 bytes) and colors (12 bytes).
      const single = () => [{ positions: distinctFloats(9), perVertexHslColors: new Float32Array(3) }];
      const renderer = initRenderer({ residentSourceBudgetBytes: 50 });
      const a = source('a', single);
      const b = source('b', single);
      const c = source('c', single);

      // All three in one frame exceed the budget, but none may go while drawn.
      render(renderer, residentCommand(a.source, 0), residentCommand(b.source, 0), residentCommand(c.source, 0));
      expect(renderer['residentSources'].size).toBe(3);
      expect(mockGL.deleteVertexArray).not.toHaveBeenCalled();

      // Only b is idle, and releasing it leaves 96 bytes: still over, but a and c were drawn.
      render(renderer, residentCommand(a.source, 0), residentCommand(c.source, 0));
      expect([...renderer['residentSources'].keys()]).toEqual(['a', 'c']);
      render(renderer, residentCommand(c.source, 0));
      expect([...renderer['residentSources'].keys()]).toEqual(['c']);
      expect(renderer['residentSourceBytes']).toBe(48);

      vi.clearAllMocks();
      render(renderer, residentCommand(b.source, 0));
      expect(b.rebuild).toHaveBeenCalledOnce();
      expect(getDrawCounts(mockGL)).toEqual([3]);
      // c, now the least recently drawn, makes room for b after the frame.
      expect([...renderer['residentSources'].keys()]).toEqual(['b']);
      expect(mockGL.deleteVertexArray).toHaveBeenCalledOnce();
    });

    it('retries a failing rebuild with backoff, reports it once when it persists, and recovers', () => {
      vi.useFakeTimers();
      try {
        const renderer = initRenderer();
        const { source: broken, rebuild } = source();
        render(renderer, residentCommand(broken, 0));
        loseContext(canvas);
        restoreContext(canvas);
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        let frame = 0;
        const attemptFrames: number[] = [];
        rebuild.mockImplementation(() => {
          attemptFrames.push(frame);
          if (attemptFrames.length <= 5) throw new Error('cache gone');
          return twoPartBuild();
        });
        vi.clearAllMocks();

        const drawn: number[][] = [];
        for (; frame < 40; frame++) {
          vi.mocked(mockGL.drawArrays).mockClear();
          render(renderer, residentCommand(broken, 0), createTestMeshCommand());
          drawn.push(getDrawCounts(mockGL));
        }

        // The next frame, then doubling waits: one attempt per interval, never one per frame.
        expect(attemptFrames).toEqual([0, 1, 3, 7, 15, 31]);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledOnce();
        // Everything else draws throughout; the source draws completely from its recovery on.
        expect(drawn.slice(0, 31).every((counts) => counts.length === 1 && counts[0] === 3)).toBe(true);
        expect(drawn.slice(31).every((counts) => counts.length === 2)).toBe(true);
        expect(renderer['pendingSources'].size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts a failing source afresh after a context restore', () => {
      vi.useFakeTimers();
      try {
        const renderer = initRenderer();
        const { source: broken, rebuild } = source();
        render(renderer, residentCommand(broken, 0));
        loseContext(canvas);
        restoreContext(canvas);
        vi.spyOn(log, 'warn').mockImplementation(() => {});
        rebuild.mockImplementation(() => {
          throw new Error('cache gone');
        });
        for (let frame = 0; frame < 8; frame++) render(renderer, residentCommand(broken, 0));
        expect(rebuild).toHaveBeenCalledTimes(4);
        rebuild.mockImplementation(twoPartBuild);

        loseContext(canvas);
        restoreContext(canvas);
        render(renderer, residentCommand(broken, 0));

        // Mid-backoff before the restore, yet retried on the first frame after it.
        expect(rebuild).toHaveBeenCalledTimes(5);
        expect(renderer['residentSources'].get(broken.id)?.source).toBe(broken);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('transactional uploads', () => {
      /** Three parts: 3, 6 and 3 vertices, with positions and colors. */
      const threeParts = () =>
        [3, 6, 3].map((vertexCount) => ({
          positions: distinctFloats(vertexCount * 3),
          perVertexHslColors: new Float32Array(vertexCount),
        }));

      function failOnce(method: 'createVertexArray' | 'createBuffer', call: number): void {
        let calls = 0;
        vi.mocked(mockGL[method]).mockImplementation((() =>
          ++calls === call ? null : { __id: Math.random() }) as never);
      }

      it.each([
        ['the first part', 'createVertexArray', 1, 0, 0],
        ['a middle part', 'createVertexArray', 2, 1, 2],
        ['a middle part’s second buffer', 'createBuffer', 4, 2, 3],
      ] as const)('publishes nothing when %s fails, cleans up, and draws completely on the retry', (_, method, call, vaosDeleted, buffersDeleted) => {
        const renderer = initRenderer();
        vi.spyOn(log, 'warn').mockImplementation(() => {});
        const { source: effect, rebuild, firstBuild } = source('spotanim-1', threeParts);
        const commands = [0, 1, 2].map((part) => residentCommand(effect, part));
        failOnce(method, call);

        render(renderer, ...commands, createTestMeshCommand());

        expect(renderer['residentSources'].size).toBe(0);
        expect(getDrawCounts(mockGL)).toEqual([3]);
        expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(vaosDeleted);
        expect(mockGL.deleteBuffer).toHaveBeenCalledTimes(buffersDeleted);
        expect(renderer['residentSourceBytes']).toBe(0);

        vi.mocked(mockGL.drawArrays).mockClear();
        vi.mocked(mockGL.bufferData).mockClear();
        render(renderer, ...commands, createTestMeshCommand());

        // The retry uploads the very arrays handed over at the failed attempt: no rebuild.
        expect(rebuild).not.toHaveBeenCalled();
        expect(uploads()).toEqual(firstBuild?.flatMap((part) => [part.positions, part.perVertexHslColors]));
        expect(getDrawCounts(mockGL)).toEqual([3, 6, 3, 3]);
        expect(renderer['residentSources'].get('spotanim-1')?.parts.every((part) => part !== null)).toBe(true);
        expect(renderer['pendingSources'].size).toBe(0);
      });

      it('still treats an empty part as resident and draws the rest', () => {
        const renderer = initRenderer();
        const { source: effect } = source('spotanim-1', () => [
          { positions: distinctFloats(9) },
          { positions: new Float32Array(0) },
        ]);
        render(renderer, residentCommand(effect, 0), residentCommand(effect, 1));
        expect(renderer['residentSources'].get('spotanim-1')?.parts.map((part) => part !== null)).toEqual([
          true,
          false,
        ]);
        expect(getDrawCounts(mockGL)).toEqual([3]);
      });
    });

    describe('GL allocation failures', () => {
      const OUT_OF_MEMORY = 0x0505;
      const INVALID_ENUM = 0x0500;

      it('does not publish an upload whose bufferData ran out of memory, keeps its arrays and retries', () => {
        const renderer = initRenderer();
        vi.spyOn(log, 'warn').mockImplementation(() => {});
        const { source: effect, rebuild, firstBuild } = source('spotanim-1');
        // Handles are created, but the first allocation fails as WebGL reports it: through getError.
        let flag = 0;
        let allocations = 0;
        vi.mocked(mockGL.bufferData).mockImplementation(() => {
          if (++allocations === 1) flag = OUT_OF_MEMORY;
        });
        vi.mocked(mockGL.getError).mockImplementation(() => {
          const raised = flag;
          flag = 0;
          return raised;
        });

        render(renderer, residentCommand(effect, 0), residentCommand(effect, 1, true));

        expect(renderer['residentSources'].size).toBe(0);
        expect(renderer['residentSourceBytes']).toBe(0);
        expect(getDrawCounts(mockGL)).toEqual([]);
        // Every handle the attempt created is deleted again.
        expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(vi.mocked(mockGL.createVertexArray).mock.calls.length);
        expect(mockGL.deleteBuffer).toHaveBeenCalledTimes(vi.mocked(mockGL.createBuffer).mock.calls.length);
        expect(renderer['pendingSources'].get('spotanim-1')?.arrays).toBe(firstBuild);

        render(renderer, residentCommand(effect, 0), residentCommand(effect, 1, true));

        expect(rebuild).not.toHaveBeenCalled();
        expect(getDrawCounts(mockGL)).toEqual([3, 6]);
        expect(renderer['residentSources'].get('spotanim-1')?.source).toBe(effect);
        expect(renderer['pendingSources'].size).toBe(0);
      });

      it('does not blame an upload for an error raised before it', () => {
        const renderer = initRenderer();
        let stale = INVALID_ENUM;
        vi.mocked(mockGL.getError).mockImplementation(() => {
          const raised = stale;
          stale = 0;
          return raised;
        });
        const { source: effect } = source('spotanim-1');

        render(renderer, residentCommand(effect, 0));

        expect(renderer['residentSources'].get('spotanim-1')?.source).toBe(effect);
        expect(getDrawCounts(mockGL)).toEqual([3]);
      });
    });

    describe('supersede by id', () => {
      it.skipIf(!collectGarbage)(
        'drops a failed predecessor and its pending arrays when a replacement takes its id',
        async () => {
          const renderer = initRenderer();
          vi.spyOn(log, 'warn').mockImplementation(() => {});
          (mockGL as { bufferData: unknown }).bufferData = () => {};
          let vaos = 0;
          vi.mocked(mockGL.createVertexArray).mockImplementation((() =>
            ++vaos === 1 ? null : { __id: Math.random() }) as never);
          const arrays = (() => {
            const build = twoPartBuild();
            // Terrain rebuilt for smoothing: same id, new source, and no retirement involved.
            const smooth = new ImmutableMeshSource('terrain-0-0-level-0', build, twoPartBuild);
            render(renderer, residentCommand(smooth, 0));
            expect(renderer['pendingSources'].get(smooth.id)?.arrays).toBe(build);
            return build.flatMap((part) => Object.values(part)).map((array) => new WeakRef(array));
          })();

          const flat = new ImmutableMeshSource('terrain-0-0-level-0', twoPartBuild(), twoPartBuild);
          render(renderer, residentCommand(flat, 0));
          frame.queue.commands = [];
          await collectGarbageUntilCleared(arrays);

          expect(arrays.map((array) => array.deref())).toEqual(arrays.map(() => undefined));
          expect(renderer['residentSources'].get(flat.id)?.source).toBe(flat);
          expect(renderer['pendingSources'].size).toBe(0);
        },
      );

      it('lets a queued source supersede a queued predecessor under the same id', () => {
        const renderer = initRenderer();
        const { source: first } = source('spotanim-1', twoPartBuild, 'loader');
        const { source: second } = source('spotanim-1', twoPartBuild, 'loader');
        renderer.prepareResidentSources([first]);
        renderer.prepareResidentSources([second]);
        render(renderer);

        expect(first.holdsFirstBuild).toBe(true);
        expect(renderer['residentSources'].get('spotanim-1')?.source).toBe(second);
      });
    });

    describe('reporting and stats', () => {
      afterEach(() => {
        renderStats.setEnabled(false);
      });

      it('logs a persistent failure exactly once, as one contextual error', () => {
        const renderer = initRenderer();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(log, 'error').mockImplementation(() => {});
        const cause = new Error('cache gone');
        const broken = new ImmutableMeshSource('spotanim-1', [], () => {
          throw cause;
        });
        broken.materialize();
        for (let frame = 0; frame < 200; frame++) render(renderer, residentCommand(broken, 0));

        const reported = error.mock.calls.map(([, ...args]) => args);
        expect(reported).toHaveLength(1);
        const errors = reported[0]?.filter((argument) => argument instanceof Error) as Error[];
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toContain('spotanim-1');
        expect(errors[0]?.cause).toBe(cause);
      });

      it('computes mesh stats only while render stats are enabled', () => {
        const renderer = initRenderer();
        const setVaoCacheSize = vi.spyOn(renderStats, 'setVaoCacheSize');
        const setEstimatedGpuMemoryBytes = vi.spyOn(renderStats, 'setEstimatedGpuMemoryBytes');
        const { source: scenery } = source();
        render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true), createTestMeshCommand());
        expect(setVaoCacheSize).not.toHaveBeenCalled();
        expect(setEstimatedGpuMemoryBytes).not.toHaveBeenCalled();

        vi.spyOn(log, 'info').mockImplementation(() => {});
        renderStats.setEnabled(true);
        render(renderer, residentCommand(scenery, 0), residentCommand(scenery, 1, true), createTestMeshCommand());

        expect(setVaoCacheSize).toHaveBeenLastCalledWith(3);
        expect(setEstimatedGpuMemoryBytes).toHaveBeenLastCalledWith(
          renderer['residentSourceBytes'] + (renderer['meshVaoCache'].get('test-mesh')?.bytes ?? 0),
        );
      });
    });

    describe('retirement', () => {
      it('releases a source whose inputs were replaced between frames, and never rebuilds it', () => {
        const renderer = initRenderer();
        let generation = 0;
        const rebuild = vi.fn(twoPartBuild);
        const effect = new ImmutableMeshSource('spotanim-1', twoPartBuild(), rebuild, {
          scope: 'loader',
          isRetired: () => generation !== 0,
        });
        render(renderer, residentCommand(effect, 0));
        generation++;

        render(renderer);
        expect(renderer['residentSources'].size).toBe(0);
        expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(2);

        vi.mocked(mockGL.drawArrays).mockClear();
        render(renderer, residentCommand(effect, 0));
        expect(rebuild).not.toHaveBeenCalled();
        expect(mockGL.drawArrays).not.toHaveBeenCalled();
        expect(renderer['pendingSources'].size).toBe(0);
      });

      it.skipIf(!collectGarbage)(
        'forgets a failed source once retired and replaced, leaving its pending arrays unreachable',
        async () => {
          const renderer = initRenderer();
          vi.spyOn(log, 'warn').mockImplementation(() => {});
          // A recording mock would keep the arrays alive through its call log.
          (mockGL as { bufferData: unknown }).bufferData = () => {};
          let generation = 0;
          let vaos = 0;
          vi.mocked(mockGL.createVertexArray).mockImplementation((() =>
            ++vaos === 1 ? null : { __id: Math.random() }) as never);
          const pending = (() => {
            const build = twoPartBuild();
            const stale = new ImmutableMeshSource('spotanim-1', build, twoPartBuild, {
              scope: 'loader',
              isRetired: () => generation !== 0,
            });
            // Drawn only, never prepared: the failed upload keeps the handed-over arrays for its retry.
            render(renderer, residentCommand(stale, 0));
            expect(renderer['pendingSources'].get(stale.id)?.arrays).toBe(build);
            return build.flatMap((part) => Object.values(part)).map((array) => new WeakRef(array));
          })();

          // The generation moves on, and its replacement is drawn instead.
          generation++;
          const fresh = new ImmutableMeshSource('spotanim-1', twoPartBuild(), twoPartBuild, { scope: 'loader' });
          render(renderer, residentCommand(fresh, 0));
          frame.queue.commands = [];
          await collectGarbageUntilCleared(pending);

          expect(renderer['pendingSources'].size).toBe(0);
          expect(pending.map((array) => array.deref())).toEqual(pending.map(() => undefined));
          expect(renderer['residentSources'].get('spotanim-1')?.source).toBe(fresh);
        },
      );

      it.skipIf(!collectGarbage)(
        "releases an owner's residents and queued sources, leaving them unreachable, and keeps other owners'",
        async () => {
          const renderer = initRenderer();
          const other = { name: 'current loader' };
          const kept = new ImmutableMeshSource('spotanim-9', twoPartBuild(), twoPartBuild, {
            scope: 'loader',
            owner: other,
          });
          const refs = (() => {
            const replaced = { name: 'replaced loader' };
            const drawn = new ImmutableMeshSource('spotanim-1', twoPartBuild(), twoPartBuild, {
              scope: 'loader',
              owner: replaced,
            });
            const queued = new ImmutableMeshSource('spotanim-2', twoPartBuild(), twoPartBuild, {
              scope: 'loader',
              owner: replaced,
            });
            render(renderer, residentCommand(drawn, 0), residentCommand(kept, 0));
            renderer.prepareResidentSources([queued]);
            expect(renderer['pendingSources'].get(queued.id)?.queued).toBe(true);

            renderer.retireResidentSources(replaced);

            expect([...renderer['residentSources'].keys()]).toEqual(['spotanim-9']);
            expect(renderer['pendingSources'].size).toBe(0);
            return [replaced, drawn, queued].map((target) => new WeakRef(target));
          })();
          frame.queue.commands = [];
          await collectGarbageUntilCleared(refs);

          expect(refs.map((ref) => ref.deref())).toEqual([undefined, undefined, undefined]);
          vi.mocked(mockGL.drawArrays).mockClear();
          render(renderer, residentCommand(kept, 0));
          expect(getDrawCounts(mockGL)).toEqual([3]);
        },
      );
    });

    it.skipIf(!collectGarbage)('leaves no CPU copy of the first build reachable once it is uploaded', async () => {
      const renderer = initRenderer();
      // A recording mock would keep the uploaded arrays alive through its call log.
      (mockGL as { bufferData: unknown }).bufferData = () => {};
      const { scenery, arrays } = (() => {
        const build = twoPartBuild();
        return {
          scenery: new ImmutableMeshSource('merged-static-locs', build, twoPartBuild),
          arrays: build.flatMap((part) => Object.values(part)).map((array) => new WeakRef(array)),
        };
      })();
      const commands = [residentCommand(scenery, 0), residentCommand(scenery, 1, true)];
      // Until it is uploaded, the source holds the first build.
      await collectGarbageAfterJob();
      expect(arrays.every((array) => array.deref() !== undefined)).toBe(true);

      render(renderer, ...commands);
      frame.queue.commands = [];
      await collectGarbageUntilCleared(arrays);

      expect(arrays.map((array) => array.deref())).toEqual(arrays.map(() => undefined));
      // The commands, the source and the renderer are all still alive and drawing.
      render(renderer, ...commands);
      expect(getDrawCounts(mockGL)).toEqual([3, 6, 3, 6]);
    });

    describe('loader-scoped sources', () => {
      it('stay resident across a scene release, drawn again without a rebuild, while scene sources go', () => {
        const renderer = initRenderer();
        const effect = source('spotanim-1', twoPartBuild, 'loader');
        const scenery = source('merged-static-locs');
        render(renderer, residentCommand(effect.source, 0), residentCommand(scenery.source, 0));

        renderer.releaseSceneMeshes();
        expect([...renderer['residentSources'].keys()]).toEqual(['spotanim-1']);
        expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(2);
        vi.mocked(mockGL.bufferData).mockClear();
        render(renderer, residentCommand(effect.source, 0), residentCommand(effect.source, 1, true));

        expect(effect.rebuild).not.toHaveBeenCalled();
        expect(mockGL.bufferData).not.toHaveBeenCalled();
        expect(getDrawCounts(mockGL)).toEqual([3, 3, 3, 6]);
        expect(renderer['residentSourceBytes']).toBe(renderer['residentSources'].get('spotanim-1')?.bytes);
      });

      it('are rebuilt after a context loss and released by the budget and dispose', () => {
        vi.useFakeTimers();
        try {
          const single = () => [{ positions: distinctFloats(9), perVertexHslColors: new Float32Array(3) }];
          const renderer = initRenderer({ residentSourceBudgetBytes: 50 });
          const first = source('spotanim-1', single, 'loader');
          const second = source('spotanim-2', single, 'loader');
          render(renderer, residentCommand(first.source, 0));

          loseContext(canvas);
          restoreContext(canvas);
          render(renderer, residentCommand(first.source, 0));
          expect(first.rebuild).toHaveBeenCalledOnce();

          // Over budget, the idle loader source goes like any other.
          render(renderer, residentCommand(second.source, 0));
          expect([...renderer['residentSources'].keys()]).toEqual(['spotanim-2']);

          renderer.dispose();
          expect(renderer['residentSources'].size).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('are superseded by a rebake under the same id, after the loader cache is cleared', () => {
        const renderer = initRenderer();
        const stale = source('spotanim-1', twoPartBuild, 'loader');
        render(renderer, residentCommand(stale.source, 0));
        renderer.releaseSceneMeshes();
        const rebaked = source('spotanim-1', twoPartBuild, 'loader');
        render(renderer, residentCommand(rebaked.source, 0));

        expect(renderer['residentSources'].get('spotanim-1')?.source).toBe(rebaked.source);
        expect(mockGL.deleteVertexArray).toHaveBeenCalledTimes(2);
        expect(stale.rebuild).not.toHaveBeenCalled();
      });
    });

    describe('upload ahead', () => {
      const MiB = 1024 * 1024;
      /** One part of `megabytes` of positions. */
      const sized = (megabytes: number) => () => [{ positions: distinctFloats((megabytes * MiB) / 4) }];

      it('uploads prepared sources at the next frames, a bounded amount per frame, handing over the first build', () => {
        const renderer = initRenderer();
        const sources = [1, 2, 3].map((index) => source(`spotanim-${index}`, sized(3), 'loader'));
        const firstBuilds = sources.map(({ firstBuild }) => firstBuild[0]?.positions);

        renderer.prepareResidentSources(sources.map(({ source: prepared }) => prepared));
        expect(mockGL.bufferData).not.toHaveBeenCalled();

        // 4 MiB per frame: the first two sources (3 MiB each) go in one frame, the third in the next.
        // Compared by identity: the uploads are the very arrays built at load.
        const uploaded = () => uploads().map((data) => firstBuilds.indexOf(data as Float32Array));
        render(renderer);
        expect(uploaded()).toEqual([0, 1]);
        render(renderer);
        expect(uploaded()).toEqual([0, 1, 2]);
        expect(sources.map(({ source: prepared }) => prepared.holdsFirstBuild)).toEqual([false, false, false]);
        expect(sources.some(({ rebuild }) => rebuild.mock.calls.length > 0)).toBe(false);
        expect(mockGL.drawArrays).not.toHaveBeenCalled();

        // Drawing them later uploads nothing more.
        render(renderer, ...sources.map(({ source: prepared }) => residentCommand(prepared, 0)));
        expect(uploads()).toHaveLength(3);
        expect(getDrawCounts(mockGL)).toHaveLength(3);
      });

      it('never rebuilds: sources already drawn or released are not queued', () => {
        const renderer = initRenderer();
        const drawn = source('spotanim-1');
        render(renderer, residentCommand(drawn.source, 0));
        renderer.releaseSceneMeshes();
        vi.mocked(mockGL.bufferData).mockClear();

        renderer.prepareResidentSources([drawn.source]);
        render(renderer);

        expect(drawn.rebuild).not.toHaveBeenCalled();
        expect(mockGL.bufferData).not.toHaveBeenCalled();
      });

      it('waits out a lost context, and drops queued scene sources at a scene release', () => {
        vi.useFakeTimers();
        try {
          const renderer = initRenderer();
          const effect = source('spotanim-1', twoPartBuild, 'loader');
          const scenery = source('merged-static-locs');
          renderer.prepareResidentSources([effect.source, scenery.source]);
          loseContext(canvas);
          render(renderer);
          expect(mockGL.bufferData).not.toHaveBeenCalled();

          restoreContext(canvas);
          renderer.releaseSceneMeshes();
          render(renderer);

          expect([...renderer['residentSources'].keys()]).toEqual(['spotanim-1']);
          expect(scenery.source.holdsFirstBuild).toBe(true);
          expect(effect.rebuild).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it.skipIf(!collectGarbage)('leaves no CPU copy of a prepared source once its frame has run', async () => {
        const renderer = initRenderer();
        (mockGL as { bufferData: unknown }).bufferData = () => {};
        const { effect, arrays } = (() => {
          const build = twoPartBuild();
          return {
            effect: new ImmutableMeshSource('spotanim-1', build, twoPartBuild, { scope: 'loader' }),
            arrays: build.flatMap((part) => Object.values(part)).map((array) => new WeakRef(array)),
          };
        })();
        renderer.prepareResidentSources([effect]);
        await collectGarbageAfterJob();
        expect(arrays.every((array) => array.deref() !== undefined)).toBe(true);

        render(renderer);
        await collectGarbageUntilCleared(arrays);

        expect(arrays.map((array) => array.deref())).toEqual(arrays.map(() => undefined));
        render(renderer, residentCommand(effect, 0), residentCommand(effect, 1, true));
        expect(getDrawCounts(mockGL)).toEqual([3, 6]);
      });
    });
  });

  describe('shader program failures', () => {
    // Compile order is scene-base, then scene-effects.
    it('keeps drawing through scene-base when scene-effects fails to link, reporting it once', () => {
      failProgramLink(mockGL, 2);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
      const renderer = new PicoGLRenderer();

      renderer.init(canvas);
      renderer.resize(createMockViewport());
      const [baseProgram, effectsProgram] = vi.mocked(mockGL.createProgram).mock.results.map(({ value }) => value);
      const frame = createMockRenderFrame();
      frame.queue.commands = [createTestMeshCommand({ shaderId: 'scene-effects' })];
      renderer.render(frame);

      expect(reported).toHaveBeenCalledOnce();
      expect(mockGL.deleteProgram).toHaveBeenCalledWith(effectsProgram);
      expect(lastNonNullArg(vi.mocked(mockGL.useProgram).mock.calls, 0)).toBe(baseProgram);
      expect(mockGL.drawArrays).toHaveBeenCalled();
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
    });

    it('fails init when scene-base, the fallback every draw needs, fails to link', () => {
      failProgramLink(mockGL, 1);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => new PicoGLRenderer().init(canvas)).toThrow('Shader program failed to link');
    });
  });

  describe('WebGL context loss during init', () => {
    it('installs the context-loss listeners before compiling shaders', () => {
      // A context already lost at init makes createShader return null. Compiling
      // first means the throw happens before webglcontextrestored is subscribed, so
      // the restore never arrives and the session renders nothing forever.
      const order: string[] = [];
      vi.spyOn(canvas, 'addEventListener').mockImplementation(((type: string) => {
        order.push(`listen:${type}`);
      }) as never);
      vi.mocked(mockGL.shaderSource).mockImplementation(() => {
        order.push('shaderSource');
      });

      new PicoGLRenderer().init(canvas);

      expect(order).toContain('listen:webglcontextrestored');
      expect(order).toContain('shaderSource');
      expect(order.indexOf('listen:webglcontextrestored')).toBeLessThan(order.indexOf('shaderSource'));
    });

    it('warns rather than reporting when the compile fails because the context is lost', () => {
      vi.useFakeTimers();
      vi.mocked(mockGL.isContextLost).mockReturnValue(true);
      vi.mocked(mockGL.createShader).mockReturnValue(null);
      vi.mocked(mockGL.shaderSource).mockImplementation(((shader: unknown) => {
        if (shader === null) {
          throw new TypeError("Argument 1 ('shader') to WebGL2RenderingContext.shaderSource must be an instance");
        }
      }) as never);
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});

      const renderer = new PicoGLRenderer();
      renderer.init(canvas);

      expect(warn).toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      // The lost event may have fired before the listener existed, so init itself
      // enters the lost state and starts the restore clock.
      expect(renderer.getContextStatus()).toEqual({ kind: 'lost' });

      vi.mocked(mockGL.isContextLost).mockReturnValue(false);
      vi.mocked(mockGL.createShader).mockImplementation(() => ({ __id: Math.random() }) as never);
      restoreContext(canvas);
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
      renderer.dispose();
      vi.useRealTimers();
    });

    it('throws a compile failure that is not a lost context, after removing its listeners', () => {
      vi.mocked(mockGL.shaderSource).mockImplementation(() => {
        throw new Error('shader source rejected');
      });
      const removeListener = vi.spyOn(canvas, 'removeEventListener');

      expect(() => new PicoGLRenderer().init(canvas)).toThrow('shader source rejected');
      expect(removeListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
      expect(removeListener).toHaveBeenCalledWith('webglcontextrestored', expect.any(Function));
    });
  });

  describe('WebGL context loss handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('flushes only at texture preparation before initial and restored draws, never on ongoing frames', () => {
      const renderer = new PicoGLRenderer();
      const frame = createMockRenderFrame();
      frame.queue.commands = [createTestMeshCommand()];
      renderer.loadTextures(createMockTextureLoader());
      renderer.render(frame);
      expect(mockGL.flush).not.toHaveBeenCalled();
      renderer.init(canvas);
      expect(mockGL.flush).not.toHaveBeenCalled();
      renderer.loadTextures(createMockTextureLoader());
      renderer.resize(createMockViewport());
      expect(mockGL.flush).toHaveBeenCalledOnce();
      renderer.render(frame);
      renderer.render(frame);
      expect(mockGL.flush).toHaveBeenCalledOnce();
      expect(vi.mocked(mockGL.flush).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(mockGL.drawArrays).mock.invocationCallOrder[0]!,
      );
      loseContext(canvas);
      renderer.render(frame);
      expect(mockGL.flush).toHaveBeenCalledOnce();
      restoreContext(canvas);
      expect(mockGL.flush).toHaveBeenCalledTimes(2);
      vi.mocked(mockGL.drawArrays).mockClear();
      renderer.render(frame);
      renderer.render(frame);
      expect(mockGL.flush).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockGL.flush).mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(mockGL.drawArrays).mock.invocationCallOrder[0]!,
      );
      renderer.dispose();
      renderer.loadTextures(createMockTextureLoader());
      renderer.render(frame);
      expect(mockGL.flush).toHaveBeenCalledTimes(2);
    });

    it('times out a loss found at the init check, through effects that still run after init', () => {
      vi.mocked(mockGL.isContextLost).mockReturnValue(true);
      vi.mocked(mockGL.shaderSource).mockImplementation(() => {
        throw new Error('lost during shader compilation');
      });
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      const event = loseContext(canvas);
      expect(event.defaultPrevented).toBe(true);
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);

      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-timeout' });
      renderer.dispose();
    });

    it('times out a loss event during compilation', () => {
      vi.mocked(mockGL.shaderSource).mockImplementationOnce(() => {
        vi.mocked(mockGL.isContextLost).mockReturnValue(true);
        loseContext(canvas);
        throw new Error('lost during shader compilation');
      });
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-timeout' });
      renderer.dispose();
    });

    it('pauses rendering when context is lost', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());

      const frame = createMockRenderFrame();
      renderer.render(frame);
      expect(mockGL.clear).toHaveBeenCalled();

      vi.clearAllMocks();

      const contextLostEvent = new Event('webglcontextlost');
      Object.defineProperty(contextLostEvent, 'preventDefault', {
        value: vi.fn(),
        writable: true,
      });
      canvas.dispatchEvent(contextLostEvent);

      expect(contextLostEvent.preventDefault).toHaveBeenCalled();

      renderer.render(frame);
      expect(mockGL.clear).not.toHaveBeenCalled();
    });

    it('reinitializes renderer when context is restored', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());

      const contextLostEvent = new Event('webglcontextlost');
      Object.defineProperty(contextLostEvent, 'preventDefault', {
        value: vi.fn(),
        writable: true,
      });
      canvas.dispatchEvent(contextLostEvent);

      vi.clearAllMocks();

      const contextRestoredEvent = new Event('webglcontextrestored');
      canvas.dispatchEvent(contextRestoredEvent);

      expect(canvas.getContext).toHaveBeenCalledWith('webgl2', expect.any(Object));

      const frame = createMockRenderFrame();
      renderer.render(frame);
      expect(mockGL.clear).toHaveBeenCalled();
    });

    it('removes event listeners on dispose', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);

      const removeEventListenerSpy = vi.spyOn(canvas, 'removeEventListener');
      renderer.dispose();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('webglcontextrestored', expect.any(Function));
    });

    it('handles context restoration failure gracefully', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);

      const contextLostEvent = new Event('webglcontextlost');
      Object.defineProperty(contextLostEvent, 'preventDefault', {
        value: vi.fn(),
        writable: true,
      });
      canvas.dispatchEvent(contextLostEvent);

      vi.spyOn(canvas, 'getContext').mockReturnValue(null);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const contextRestoredEvent = new Event('webglcontextrestored');
      canvas.dispatchEvent(contextRestoredEvent);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Renderer]',
        expect.stringContaining('restore context'),
        expect.any(Error),
      );
      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-restore' });

      consoleErrorSpy.mockRestore();
    });

    it('rebuilds mesh buffers, the texture array and programs on new handles after a restore', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      const manager = renderer.getTextureArrayManager();
      const layersBefore = [1, 2, 3].map((id) => manager?.getTextureIndex(id));
      const frame = createMockRenderFrame();
      // Animated, because that path could bufferSubData into the cached (dead) buffers.
      frame.queue.commands = [createTestMeshCommand({ animated: true, indices: new Uint16Array([0, 1, 2]) })];

      renderer.render(frame);
      const isArrayTextureBind = (call: readonly unknown[]) => call[0] === mockGL.TEXTURE_2D_ARRAY;
      const vaoBefore = lastNonNullArg(vi.mocked(mockGL.bindVertexArray).mock.calls, 0);
      const textureBefore = lastNonNullArg(vi.mocked(mockGL.bindTexture).mock.calls, 1, isArrayTextureBind);
      const programBefore = lastNonNullArg(vi.mocked(mockGL.useProgram).mock.calls, 0);
      const buffersBefore = new Set(vi.mocked(mockGL.createBuffer).mock.results.map((result) => result.value));
      const statuses: RenderStatus['kind'][] = [];
      renderer.subscribeContextStatus((status) => statuses.push(status.kind));

      loseContext(canvas);
      restoreContext(canvas);
      vi.clearAllMocks();
      renderer.render(frame);

      expect(statuses).toEqual(['lost', 'restoring', 'ok']);
      expect(mockGL.createVertexArray).toHaveBeenCalled();
      expect(lastNonNullArg(vi.mocked(mockGL.bindVertexArray).mock.calls, 0)).not.toBe(vaoBefore);
      const textureAfter = lastNonNullArg(vi.mocked(mockGL.bindTexture).mock.calls, 1, isArrayTextureBind);
      expect(textureAfter).not.toBe(textureBefore);
      expect(lastNonNullArg(vi.mocked(mockGL.useProgram).mock.calls, 0)).not.toBe(programBefore);
      const boundBuffers = vi.mocked(mockGL.bindBuffer).mock.calls.map(([, buffer]) => buffer);
      expect(boundBuffers.some((buffer) => buffersBefore.has(buffer))).toBe(false);
      expect(mockGL.drawElements).toHaveBeenCalled();
      // Same manager, same id order: meshes baked against the old layer mapping stay valid.
      expect(renderer.getTextureArrayManager()).toBe(manager);
      expect([1, 2, 3].map((id) => manager?.getTextureIndex(id))).toEqual(layersBefore);
    });

    it('rebuilds a scene-base batch after a restore with no normal or alpha buffer, its alpha constant reset to 1', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      const scenery: NpcMesh3DCommand = {
        ...createTestMeshCommand({ meshId: 'merged-static-locs-opaque' }),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        perVertexHslColors: new Float32Array([100, 100, 100]),
        perVertexAlphas: new Float32Array([1, 1, 1]),
      };
      const effect: NpcMesh3DCommand = {
        ...createTestMeshCommand({ meshId: 'lobby-fx', shaderId: 'scene-effects' }),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      };
      const frame = createMockRenderFrame();
      frame.queue.commands = [scenery, effect];
      renderer.render(frame);

      loseContext(canvas);
      restoreContext(canvas);
      vi.clearAllMocks();
      renderer.render(frame);

      const uploads = vi.mocked(mockGL.bufferData).mock.calls.map(([, data]) => data);
      expect(uploads).toContain(scenery.positions);
      expect(uploads).not.toContain(scenery.normals);
      expect(uploads).toContain(effect.normals);
      expect(uploads).not.toContain(scenery.perVertexAlphas);
      expect(mockGL.drawArrays).toHaveBeenCalledTimes(2);
      // A restored context starts every generic attribute at (0, 0, 0, 1), so a_alpha must be reset before drawing.
      const alphaResets = vi
        .mocked(mockGL.vertexAttrib1f)
        .mock.calls.flatMap(([location, value], index) =>
          location === 6 ? [{ value, order: vi.mocked(mockGL.vertexAttrib1f).mock.invocationCallOrder[index]! }] : [],
        );
      expect(new Set(alphaResets.map(({ value }) => value))).toEqual(new Set([1]));
      expect(alphaResets[0]!.order).toBeLessThan(vi.mocked(mockGL.drawArrays).mock.invocationCallOrder[0]!);
    });

    it('drops asset-manager GPU handles on loss so callers re-ensure them', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.assets.ensureMesh('asset-mesh', { positions: new Float32Array(9) } as never);
      renderer.assets.ensureMaterial('asset-material', {} as never);
      expect(renderer.assets.hasMesh('asset-mesh')).toBe(true);

      loseContext(canvas);

      expect(renderer.assets.hasMesh('asset-mesh')).toBe(false);
      expect(renderer.assets.hasMaterial('asset-material')).toBe(true);
    });

    it('fails terminally when programs do not link on the restored context', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      loseContext(canvas);
      // picogl logs a link failure instead of throwing; the renderer must not call
      // that restored.
      vi.mocked(mockGL.getProgramParameter).mockReturnValue(false);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});

      restoreContext(canvas);
      vi.mocked(mockGL.clear).mockClear();
      renderer.render(createMockRenderFrame());

      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-restore' });
      expect(error).toHaveBeenCalledWith('Renderer', expect.stringContaining('restore context'), expect.any(Error));
      expect(mockGL.clear).not.toHaveBeenCalled();
    });

    it('restores with scene-base alone when scene-effects fails to link on the new context', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      loseContext(canvas);
      failProgramLink(mockGL, 2);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
      vi.mocked(mockGL.createProgram).mockClear();
      vi.mocked(mockGL.deleteProgram).mockClear();

      restoreContext(canvas);

      const [baseProgram, effectsProgram] = vi.mocked(mockGL.createProgram).mock.results.map(({ value }) => value);
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
      expect(reported).toHaveBeenCalledOnce();
      expect(mockGL.deleteProgram).toHaveBeenCalledWith(effectsProgram);
      expect(mockGL.deleteProgram).not.toHaveBeenCalledWith(baseProgram);
    });

    it('restores untextured, and reports it, when the texture array cannot be re-uploaded', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      loseContext(canvas);
      // Three textures plus the placeholder no longer fit, so the re-upload throws.
      vi.mocked(mockGL.getParameter).mockImplementation((pname: number) => (pname === 0x88ff ? 2 : 4096));
      const reported = vi.spyOn(log, 'error').mockImplementation(() => {});

      restoreContext(canvas);
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
      expect(reported).toHaveBeenCalledWith('Renderer', expect.stringContaining('untextured'), expect.any(Error));

      vi.clearAllMocks();
      const frame = createMockRenderFrame();
      frame.queue.commands = [createTestMeshCommand()];
      renderer.render(frame);

      expect(mockGL.drawArrays).toHaveBeenCalled();
      expect(vi.mocked(mockGL.bindTexture).mock.calls.some(([target]) => target === mockGL.TEXTURE_2D_ARRAY)).toBe(
        false,
      );
      expect(getUniform1fValues(mockGL, 'u_hasTextures')).toContain(0);
    });

    it('goes back to waiting when the context is lost again mid-restore, then recovers', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      loseContext(canvas);
      vi.mocked(mockGL.isContextLost).mockReturnValue(true);
      vi.mocked(mockGL.createShader).mockReturnValue(null);
      vi.mocked(mockGL.shaderSource).mockImplementation(((shader: unknown) => {
        if (shader === null) throw new TypeError('shaderSource: argument is not a WebGLShader');
      }) as never);
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});

      restoreContext(canvas);

      expect(renderer.getContextStatus()).toEqual({ kind: 'lost' });
      expect(error).not.toHaveBeenCalled();

      vi.mocked(mockGL.isContextLost).mockReturnValue(false);
      vi.mocked(mockGL.createShader).mockImplementation(() => ({ __id: Math.random() }) as never);
      restoreContext(canvas);

      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
    });

    it('times out again when a texture reupload silently loses the restored context, then accepts a later restore', () => {
      vi.spyOn(log, 'error').mockImplementation(() => {});
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      renderer.loadTextures(createMockTextureLoader());
      const frame = createMockRenderFrame();
      frame.queue.commands = [createTestMeshCommand()];
      renderer.render(frame);
      loseContext(canvas);
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-timeout' });
      const statuses: RenderStatus['kind'][] = [];
      renderer.subscribeContextStatus((status) => statuses.push(status.kind));
      vi.mocked(mockGL.generateMipmap).mockImplementationOnce(() => {
        vi.mocked(mockGL.isContextLost).mockReturnValue(true);
      });
      const flushesBeforeRestore = vi.mocked(mockGL.flush).mock.calls.length;

      restoreContext(canvas);

      expect(statuses).toEqual(['restoring', 'lost']);
      expect(mockGL.flush).toHaveBeenCalledTimes(flushesBeforeRestore);
      vi.mocked(mockGL.drawArrays).mockClear();
      renderer.render(frame);
      expect(mockGL.drawArrays).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-timeout' });
      // The delayed DOM event changes nothing about the failed episode.
      canvas.dispatchEvent(new Event('webglcontextlost'));
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
      expect(renderer.getContextStatus()).toEqual({ kind: 'failed', reason: 'context-timeout' });

      vi.mocked(mockGL.isContextLost).mockReturnValue(false);
      restoreContext(canvas);
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
      renderer.render(frame);
      expect(mockGL.drawArrays).toHaveBeenCalled();
      renderer.dispose();
    });

    it('reports failure when a lost context is not restored in time, but still accepts a late restore', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.spyOn(log, 'error').mockImplementation(() => {});
      loseContext(canvas);

      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);
      expect(renderer.getContextStatus()).toEqual({ kind: 'lost' });
      vi.advanceTimersByTime(1);
      expect(renderer.getContextStatus()).toMatchObject({ kind: 'failed', reason: 'context-timeout' });

      restoreContext(canvas);
      expect(renderer.getContextStatus()).toEqual({ kind: 'ok' });
    });

    it('gives a page returning from hidden a fresh full restore interval', () => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      vi.spyOn(log, 'error').mockImplementation(() => {});
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      loseContext(canvas);
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);

      setVisibility(visibility, 'hidden');
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS * 3);
      setVisibility(visibility, 'visible');
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);
      expect(renderer.getContextStatus()).toEqual({ kind: 'lost' });

      vi.advanceTimersByTime(1);
      expect(renderer.getContextStatus()).toMatchObject({ kind: 'failed', reason: 'context-timeout' });
    });

    it.each(['restore', 'dispose'] as const)('stops the restore clock and its visibility listener on %s', (exit) => {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      const statuses: RenderStatus['kind'][] = [];
      renderer.subscribeContextStatus((status) => statuses.push(status.kind));
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      loseContext(canvas);

      if (exit === 'restore') restoreContext(canvas);
      else renderer.dispose();
      setVisibility(visibility, 'hidden');
      setVisibility(visibility, 'visible');
      vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS * 2);

      expect(statuses).toEqual(exit === 'restore' ? ['lost', 'restoring', 'ok'] : ['lost']);
    });
  });

  describe('instancing atlas runs', () => {
    let frame: RenderFrame;
    const QUAD: readonly [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
    ];

    /** A quad soup that indexes to four vertices; `order` picks the second triangle's winding. */
    function quad(z: number, hsl: number, alpha?: number, order: 'shared' | 'other' = 'shared'): MeshUploadData {
      const corners = order === 'shared' ? QUAD : [QUAD[0], QUAD[1], QUAD[2], QUAD[1], QUAD[5], QUAD[2]];
      return {
        positions: new Float32Array(corners.flatMap(([x, y]) => [x as number, y as number, z])),
        perVertexHslColors: new Float32Array(6).fill(hsl),
        ...(alpha === undefined ? {} : { perVertexAlphas: new Float32Array(6).fill(alpha) }),
      };
    }

    /** Parts 0 and 1 share a topology; 2 never indexes (declined); 3 has another topology. */
    function atlasBuild(): MeshUploadData[] {
      return [
        quad(0, 100),
        quad(1, 200, 0.5),
        { positions: distinctFloats(9), perVertexHslColors: new Float32Array(3).fill(300) },
        quad(2, 400, undefined, 'other'),
      ];
    }

    function atlasSource(retired = { value: false }) {
      return new ImmutableMeshSource('test-atlas', atlasBuild(), atlasBuild, {
        scope: 'loader',
        isRetired: () => retired.value,
      });
    }

    /** A command for `part`, with its own arrays (as the renderer would draw it singly) and the atlas. */
    function atlasCommand(
      source: ImmutableMeshSource | undefined,
      part: number,
      x: number,
      overrides: Partial<NpcMesh3DCommand> = {},
    ): NpcMesh3DCommand {
      const arrays = atlasBuild()[part] as MeshUploadData;
      const modelMatrix = createIdentityMatrix();
      modelMatrix[12] = x;
      return {
        kind: 'mesh3d',
        meshId: `atlas-part-${part}`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: arrays.positions,
        perVertexHslColors: arrays.perVertexHslColors,
        perVertexAlphas: arrays.perVertexAlphas,
        ...(source ? { instanceAtlas: source, instanceAtlasPart: part } : {}),
        ...overrides,
      };
    }

    function initRenderer(): PicoGLRenderer {
      const renderer = new PicoGLRenderer();
      renderer.init(canvas);
      renderer.resize(createMockViewport());
      vi.clearAllMocks();
      return renderer;
    }

    function render(renderer: PicoGLRenderer, ...commands: Mesh3DCommand[]): void {
      frame.queue.commands = commands;
      renderer.render(frame);
    }

    /** The MVP of every single draw, copied when uploaded: the renderer reuses one array for them all. */
    function captureMvps(): number[][] {
      const mvps: number[][] = [];
      vi.mocked(mockGL.uniformMatrix4fv).mockImplementation(((
        _location: unknown,
        _transpose: unknown,
        value: Float32Array,
      ) => {
        mvps.push(Array.from(value));
      }) as never);
      return mvps;
    }

    function instancedDraws(): [number, number, number][] {
      return vi
        .mocked(mockGL.drawElementsInstanced)
        .mock.calls.map(([, count, type, , instances]) => [count, type, instances]);
    }

    beforeEach(() => {
      frame = createMockRenderFrame();
      // A camera with a real projection, so every draw's MVP is distinct.
      const camera = frame.camera as Extract<RenderFrame['camera'], { kind: '3d' }>;
      camera.camera = {
        ...camera.camera,
        viewMatrix: () => new Float32Array([1, 0.1, 0, 0, -0.1, 1, 0.2, 0, 0, -0.2, 1, 0, 3, -4, -20, 1]),
        projectionMatrix: () => new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1.01, -1, 0, 0, -0.2, 0]),
      };
    });

    it('draws consecutive commands of one layout as one instanced draw, each instance the MVP its own draw gets', () => {
      const source = atlasSource();
      const commands = (atlas: ImmutableMeshSource | undefined) => [
        atlasCommand(atlas, 0, 1),
        atlasCommand(atlas, 1, 2),
        atlasCommand(undefined, 0, 3),
        atlasCommand(atlas, 1, 4),
        atlasCommand(atlas, 0, 5),
      ];
      // Every command drawn singly: the MVP each would get.
      const reference = initRenderer();
      const singly = captureMvps();
      render(reference, ...commands(undefined));
      expect(singly).toHaveLength(5);
      reference.dispose();

      const renderer = initRenderer();
      render(renderer, ...commands(source));
      expect(instancedDraws()).toEqual([
        [6, mockGL.UNSIGNED_SHORT, 2],
        [6, mockGL.UNSIGNED_SHORT, 2],
      ]);
      // The plain command between the runs is drawn on its own, between them.
      expect(vi.mocked(mockGL.drawElements).mock.calls).toHaveLength(1);
      const order = vi
        .mocked(mockGL.drawElementsInstanced)
        .mock.invocationCallOrder.concat(vi.mocked(mockGL.drawElements).mock.invocationCallOrder)
        .sort((a, b) => a - b);
      expect(order[1]).toBe(vi.mocked(mockGL.drawElements).mock.invocationCallOrder[0]);
      // One upload of every instance: the four MVPs in draw order, each followed by its row.
      const [, , staging, , floats] = vi
        .mocked(mockGL.bufferSubData)
        .mock.calls.find(([target]) => target === mockGL.ARRAY_BUFFER) as unknown as [
        number,
        number,
        Float32Array,
        number,
        number,
      ];
      expect(floats).toBe(4 * 17);
      const instances = Array.from({ length: 4 }, (_, index) =>
        Array.from(staging.subarray(index * 17, index * 17 + 17)),
      );
      expect(instances).toEqual([
        [...(singly[0] as number[]), 0],
        [...(singly[1] as number[]), 1],
        [...(singly[3] as number[]), 1],
        [...(singly[4] as number[]), 0],
      ]);
    });

    it('draws a lone command, a part that does not index, and runs broken by draw state singly', () => {
      const source = atlasSource();
      const renderer = initRenderer();
      render(
        renderer,
        atlasCommand(source, 0, 1),
        atlasCommand(undefined, 0, 2),
        atlasCommand(source, 2, 3),
        atlasCommand(source, 2, 4),
        atlasCommand(source, 3, 5),
        atlasCommand(source, 0, 6, { depthBias: 1 }),
        atlasCommand(source, 0, 7),
        atlasCommand(source, 0, 8, { cullFace: 'none' }),
        atlasCommand(source, 0, 9),
        atlasCommand(source, 1, 10, { shaderId: 'scene-effects' }),
        atlasCommand(source, 1, 11),
      );
      expect(instancedDraws()).toEqual([]);
      expect(vi.mocked(mockGL.drawElements).mock.calls.length + vi.mocked(mockGL.drawArrays).mock.calls.length).toBe(
        11,
      );
    });

    it('batches the transparent pass after sorting, only commands that end up adjacent', () => {
      const source = atlasSource();
      const renderer = initRenderer();
      const transparent = (atlas: ImmutableMeshSource | undefined, part: number, x: number) =>
        atlasCommand(atlas, part, x, { depth: 'read', blend: 'normal' });
      // Far to near by x: 40 and 30 are adjacent; the plain command at 20 separates 10.
      render(
        renderer,
        transparent(source, 1, 10),
        transparent(undefined, 1, 20),
        transparent(source, 1, 40),
        transparent(source, 1, 30),
      );
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 2]]);
      const [, , staging] = vi
        .mocked(mockGL.bufferSubData)
        .mock.calls.find(([target]) => target === mockGL.ARRAY_BUFFER) as unknown as [number, number, Float32Array];
      const reference = initRenderer();
      const singly = captureMvps();
      render(reference, transparent(undefined, 1, 40), transparent(undefined, 1, 30));
      expect([Array.from(staging.subarray(0, 16)), Array.from(staging.subarray(17, 33))]).toEqual(singly);
    });

    it('compiles scene-base with INSTANCED_ATLAS defined once a frame has a run, and samples the atlas on unit 1', () => {
      const source = atlasSource();
      const renderer = initRenderer();
      render(renderer, atlasCommand(source, 0, 1));
      expect(mockGL.shaderSource).not.toHaveBeenCalled();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      const sources = vi.mocked(mockGL.shaderSource).mock.calls.map(([, text]) => text);
      expect(sources).toEqual([
        sceneBaseVertSource.replace('#version 300 es\n', '#version 300 es\n#define INSTANCED_ATLAS\n'),
        sceneFragSource,
      ]);
      expect(vi.mocked(mockGL.uniform1i).mock.calls).toContainEqual([
        expect.objectContaining({ name: 'u_instanceAtlas' }),
        1,
      ]);
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      expect(mockGL.shaderSource).toHaveBeenCalledTimes(2);
      // Unit 1 for the atlas, and unit 0 active again afterwards for everything else.
      const units = vi.mocked(mockGL.activeTexture).mock.calls.map(([unit]) => unit);
      expect(units).toContain(mockGL.TEXTURE0 + 1);
      expect(units.at(-1)).toBe(mockGL.TEXTURE0);
    });

    it('draws every command singly, for good, when the instanced program fails to link', () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      const source = atlasSource();
      const renderer = initRenderer();
      failProgramLink(mockGL, 1);
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      expect(instancedDraws()).toEqual([]);
      expect(mockGL.drawElements).toHaveBeenCalledTimes(4);
      expect(mockGL.linkProgram).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('uploads each part’s indexed vertices as texels once, with one index buffer per topology', () => {
      const source = atlasSource();
      const renderer = initRenderer();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      render(renderer, atlasCommand(source, 3, 1), atlasCommand(source, 3, 2));
      const uploads = vi.mocked(mockGL.texImage2D).mock.calls.filter(([, , format]) => format === mockGL.RGBA32F);
      expect(uploads).toHaveLength(1);
      const [, , , width, height, , , , texels] = uploads[0] as unknown as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        Float32Array,
      ];
      // Four indexed vertices per quad, two texels each; one row per part.
      expect([width, height]).toEqual([8, 4]);
      const texel = (row: number, vertex: number) =>
        Array.from(texels.subarray((row * width + vertex * 2) * 4, (row * width + vertex * 2) * 4 + 8));
      // Position and HSL, then alpha (1 with no buffer) and face bias (+0 with none).
      expect(texel(0, 3)).toEqual([1, 1, 0, 100, 1, 0, 0, 0]);
      expect(texel(1, 0)).toEqual([0, 0, 1, 200, 0.5, 0, 0, 0]);
      expect(texel(2, 0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      const atlas = renderer['atlases'].get('test-atlas')?.atlas;
      expect(Array.from(atlas?.partLayouts ?? [])).toEqual([0, 0, -1, 1]);
      expect(atlas?.layouts.map((layout) => layout.indexCount)).toEqual([6, 6]);
      // Rows are never flipped or premultiplied; the unpack state is put back.
      const flip = vi.mocked(mockGL.pixelStorei).mock.calls.filter(([pname]) => pname === mockGL.UNPACK_FLIP_Y_WEBGL);
      expect(flip.map(([, value]) => value)).toEqual([false, 0]);
      expect(instancedDraws()).toEqual([
        [6, mockGL.UNSIGNED_SHORT, 2],
        [6, mockGL.UNSIGNED_SHORT, 2],
      ]);
    });

    it('sizes the atlas and instance buffer, and releases them with the source, a lost context and dispose', () => {
      const retired = { value: false };
      const source = atlasSource(retired);
      const renderer = initRenderer();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      const atlas = renderer['atlases'].get('test-atlas')?.atlas;
      expect(atlas?.bytes).toBe(8 * 4 * 16 + 2 * 6 * 2);
      expect(renderer['instanceCapacityBytes']).toBe(2 * 17 * 4);

      retired.value = true;
      render(renderer);
      expect(renderer['atlases'].size).toBe(0);
      expect(mockGL.deleteTexture).toHaveBeenCalledWith(atlas?.texture);
      expect(mockGL.deleteVertexArray).toHaveBeenCalledWith(atlas?.layouts[0]?.vao);

      const next = atlasSource();
      render(renderer, atlasCommand(next, 0, 1), atlasCommand(next, 0, 2));
      expect(renderer['atlases'].size).toBe(1);
      loseContext(canvas);
      expect(renderer['atlases'].size).toBe(0);
      expect(renderer['instancedProgram']).toBeUndefined();
      expect(renderer['instanceCapacityBytes']).toBe(0);
      renderer.dispose();
    });

    it('uploads an atlas prepared ahead, with its program, at the start of the next frame and never as a mesh', () => {
      const source = new ImmutableMeshSource('test-atlas', atlasBuild(), atlasBuild, {
        scope: 'loader',
        use: 'instanceAtlas',
      });
      const renderer = initRenderer();
      renderer.prepareResidentSources([source]);
      expect(mockGL.texImage2D).not.toHaveBeenCalled();
      render(renderer);
      expect(vi.mocked(mockGL.texImage2D).mock.calls.filter(([, , format]) => format === mockGL.RGBA32F)).toHaveLength(
        1,
      );
      expect(mockGL.linkProgram).toHaveBeenCalledTimes(1);
      expect(renderer['residentSources'].size + renderer['pendingSources'].size).toBe(0);
      expect(mockGL.bufferData).not.toHaveBeenCalledWith(mockGL.ARRAY_BUFFER, expect.anything(), expect.anything());
      // The first run draws from it without uploading or compiling again.
      vi.clearAllMocks();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      expect(mockGL.texImage2D).not.toHaveBeenCalled();
      expect(mockGL.linkProgram).not.toHaveBeenCalled();
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 2]]);
    });

    /** Makes the next instance-buffer allocations (`bufferData` with a size) report out of memory. */
    function failInstanceAllocations(count: number): void {
      const OUT_OF_MEMORY = 0x0505;
      let pending = 0;
      let failures = count;
      vi.mocked(mockGL.bufferData).mockImplementation(((_target: number, size: unknown) => {
        if (typeof size === 'number' && failures > 0) {
          failures--;
          pending = OUT_OF_MEMORY;
        }
      }) as never);
      vi.mocked(mockGL.getError).mockImplementation(() => {
        const error = pending;
        pending = 0;
        return error;
      });
    }

    it('draws every command singly, holding no buffer or capacity, when the first instance allocation fails', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const source = atlasSource();
      const renderer = initRenderer();
      failInstanceAllocations(2);
      for (let frame = 0; frame < 2; frame++) {
        vi.mocked(mockGL.drawElements).mockClear();
        render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
        expect(instancedDraws()).toEqual([]);
        expect(mockGL.drawElements).toHaveBeenCalledTimes(2);
        expect(renderer['instanceBuffer']).toBeNull();
        expect(renderer['instanceCapacityBytes']).toBe(0);
      }
      // Every buffer made for instances was deleted again.
      expect(mockGL.deleteBuffer).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(mockGL.bufferSubData).not.toHaveBeenCalledWith(
        mockGL.ARRAY_BUFFER,
        0,
        expect.anything(),
        0,
        expect.anything(),
      );

      // Once memory is there again, the runs draw instanced.
      vi.mocked(mockGL.drawElements).mockClear();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 2]]);
      expect(mockGL.drawElements).not.toHaveBeenCalled();
      expect(renderer['instanceCapacityBytes']).toBe(2 * 17 * 4);
    });

    it('drops the instance buffer and draws singly when it fails to grow after a good frame, then recovers', () => {
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const source = atlasSource();
      const renderer = initRenderer();
      const four = () => [1, 2, 3, 4].map((x) => atlasCommand(source, 0, x));
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      const first = renderer['instanceBuffer'];
      expect(renderer['instanceCapacityBytes']).toBe(2 * 17 * 4);

      vi.clearAllMocks();
      failInstanceAllocations(1);
      render(renderer, ...four());
      expect(instancedDraws()).toEqual([]);
      expect(mockGL.drawElements).toHaveBeenCalledTimes(4);
      // The buffer whose reallocation failed is gone, not kept with a capacity it may not have.
      expect(mockGL.deleteBuffer).toHaveBeenCalledWith(first);
      expect(renderer['instanceBuffer']).toBeNull();
      expect(renderer['instanceCapacityBytes']).toBe(0);

      vi.clearAllMocks();
      render(renderer, ...four());
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 4]]);
      expect(mockGL.drawElements).not.toHaveBeenCalled();
      expect(renderer['instanceBuffer']).not.toBeNull();
      expect(renderer['instanceCapacityBytes']).toBe(4 * 17 * 4);
    });

    it('releases its instance buffer and program on dispose', () => {
      const source = atlasSource();
      const renderer = initRenderer();
      render(renderer, atlasCommand(source, 0, 1), atlasCommand(source, 0, 2));
      const buffer = renderer['instanceBuffer'];
      renderer.dispose();
      expect(mockGL.deleteBuffer).toHaveBeenCalledWith(buffer);
      expect(renderer['atlases'].size).toBe(0);
      expect(renderer['instancedProgram']).toBeUndefined();
    });

    /** One part of `quads` quads side by side: 6 corners each, indexing to 4 vertices each. */
    function quadStrip(quads: number): MeshUploadData {
      const positions = new Float32Array(quads * 18);
      for (let quad = 0; quad < quads; quad++)
        for (const [corner, [x, y]] of QUAD.entries()) positions.set([x + 2 * quad, y, 0], quad * 18 + corner * 3);
      return { positions, perVertexHslColors: new Float32Array(quads * 6).fill(100) };
    }

    /**
     * An atlas source of `parts` 100-quad parts (as wide as the mock's 4,096-texel limit allows a few
     * times over): an upper bound of 21,600 bytes a part; built, 12,800 a part and one shared
     * 1,200-byte index buffer.
     */
    function stripSource(id: string, parts: number, isRetired?: () => boolean): ImmutableMeshSource {
      const build = () => Array.from({ length: parts }, () => quadStrip(100));
      return new ImmutableMeshSource(id, build(), build, {
        scope: 'loader',
        use: 'instanceAtlas',
        ...(isRetired ? { isRetired } : {}),
      });
    }
    const builtBytes = (parts: number) => parts * 12_800 + 1200;

    function stripCommand(source: ImmutableMeshSource, x: number): NpcMesh3DCommand {
      const modelMatrix = createIdentityMatrix();
      modelMatrix[12] = x;
      const arrays = quadStrip(100);
      return {
        kind: 'mesh3d',
        meshId: `${source.id}-part`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: arrays.positions,
        perVertexHslColors: arrays.perVertexHslColors,
        instanceAtlas: source,
        instanceAtlasPart: 0,
      };
    }

    const atlasTexels = () =>
      vi.mocked(mockGL.texImage2D).mock.calls.filter(([, , format]) => format === mockGL.RGBA32F);

    it('refuses an atlas whose bound is over the budget before building it, and does not try it again', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // 50 parts: a 1,080,000-byte bound, over 1 MiB, though built it would be 641,200.
      const big = stripSource('big-atlas', 50);
      const materialize = vi.spyOn(big, 'materialize');
      const renderer = initRenderer();
      for (let frame = 0; frame < 3; frame++) render(renderer, stripCommand(big, 1), stripCommand(big, 2));
      expect(materialize).not.toHaveBeenCalled();
      expect(atlasTexels()).toEqual([]);
      expect(instancedDraws()).toEqual([]);
      expect(mockGL.drawElements).toHaveBeenCalledTimes(6);
      expect(renderer['atlases'].get('big-atlas')).toEqual({ source: big, atlas: null });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('declines an atlas source with an indexed part before building it: its bound would not hold', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      // Three vertices, but 900,000 indices: a 108-byte bound for megabytes of input.
      const build = (): MeshUploadData[] => [
        quadStrip(1),
        {
          positions: distinctFloats(9),
          perVertexHslColors: new Float32Array(3).fill(100),
          indices: new Uint32Array(900_000),
        },
      ];
      const indexed = new ImmutableMeshSource('indexed-atlas', build(), build, {
        scope: 'loader',
        use: 'instanceAtlas',
      });
      const materialize = vi.spyOn(indexed, 'materialize');
      const renderer = initRenderer();
      // The commands draw their own arrays: only the atlas is declined.
      for (let frame = 0; frame < 3; frame++) render(renderer, stripCommand(indexed, 1), stripCommand(indexed, 2));
      expect(materialize).not.toHaveBeenCalled();
      expect(atlasTexels()).toEqual([]);
      expect(instancedDraws()).toEqual([]);
      expect(mockGL.drawElements).toHaveBeenCalledTimes(6);
      expect(renderer['atlases'].get('indexed-atlas')).toEqual({ source: indexed, atlas: null });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('holds every atlas against one budget, freed as each is released', () => {
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      // Each a 756,000-byte bound and 449,200 bytes built: one fits, a second's bound does not.
      const firstRetired = { value: false };
      const first = stripSource('first-atlas', 35, () => firstRetired.value);
      const second = stripSource('second-atlas', 35);
      const secondBuild = vi.spyOn(second, 'materialize');
      const renderer = initRenderer();
      render(
        renderer,
        stripCommand(first, 1),
        stripCommand(first, 2),
        stripCommand(second, 3),
        stripCommand(second, 4),
      );
      expect(renderer['atlases'].get('first-atlas')?.atlas?.bytes).toBe(builtBytes(35));
      expect(renderer['atlases'].get('second-atlas')?.atlas).toBeNull();
      expect(secondBuild).not.toHaveBeenCalled();
      expect(instancedDraws()).toEqual([[600, mockGL.UNSIGNED_SHORT, 2]]);

      // The first retires; a new source for the second, as its owner would make, now fits.
      firstRetired.value = true;
      render(renderer);
      expect([...renderer['atlases'].keys()]).toEqual(['second-atlas']);
      const readmitted = stripSource('second-atlas', 35);
      vi.mocked(mockGL.drawElementsInstanced).mockClear();
      render(renderer, stripCommand(readmitted, 3), stripCommand(readmitted, 4));
      expect(renderer['atlases'].get('second-atlas')?.atlas?.bytes).toBe(builtBytes(35));
      expect(instancedDraws()).toEqual([[600, mockGL.UNSIGNED_SHORT, 2]]);
      // A lost context holds no atlas, so counts none.
      loseContext(canvas);
      expect(renderer['atlases'].size).toBe(0);
      renderer.dispose();
    });

    it('lets an atlas that supersedes a retired one have its storage', () => {
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      const retired = { value: false };
      const old = stripSource('rebaked-atlas', 35, () => retired.value);
      const renderer = initRenderer();
      render(renderer, stripCommand(old, 1), stripCommand(old, 2));
      retired.value = true;
      const rebaked = stripSource('rebaked-atlas-2', 35);
      vi.mocked(mockGL.drawElementsInstanced).mockClear();
      // In the same frame as the retired one is still held: it is released first.
      render(renderer, stripCommand(rebaked, 1), stripCommand(rebaked, 2));
      expect([...renderer['atlases'].keys()]).toEqual(['rebaked-atlas-2']);
      expect(instancedDraws()).toEqual([[600, mockGL.UNSIGNED_SHORT, 2]]);
    });

    it('checks an atlas’s built size against what it may take before allocating its texels or any GL object', () => {
      const index = (part: MeshUploadData) => ({
        positions: part.positions.subarray(0, 12),
        perVertexHslColors: part.perVertexHslColors?.subarray(0, 4),
        indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
      });
      const source = atlasSource();
      // Built: 4 rows × 8 texels × 16 bytes, plus one 12-byte index buffer.
      const built = 4 * 8 * 16 + 12;
      expect(uploadAtlas(mockGL, source, atlasBuild(), index, 4096, built - 1)).toBeNull();
      expect(mockGL.createTexture).not.toHaveBeenCalled();
      expect(mockGL.createBuffer).not.toHaveBeenCalled();
      expect(uploadAtlas(mockGL, source, atlasBuild(), index, 4096, built)?.bytes).toBe(built);
    });

    // 64 KiB holds 963 instances of 68 bytes.
    it('draws a frame whose instances would take over 64 KiB singly, without growing past it', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const source = atlasSource();
      const renderer = initRenderer();
      const commands = (count: number) => Array.from({ length: count }, (_, x) => atlasCommand(source, 0, x));
      render(renderer, ...commands(700));
      expect(renderer['instanceCapacityBytes']).toBe(700 * 68);
      // Grown half again (71,400) would overshoot the cap; it grows to the cap, which fits 963.
      vi.clearAllMocks();
      render(renderer, ...commands(963));
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 963]]);
      expect(renderer['instanceCapacityBytes']).toBe(64 * 1024);
      expect(renderer['instanceStaging'].length).toBe((64 * 1024) / 4);

      vi.clearAllMocks();
      render(renderer, ...commands(964));
      // Every command, in order, drawn as without the atlas; nothing more allocated for instances.
      expect(instancedDraws()).toEqual([]);
      expect(mockGL.drawElements).toHaveBeenCalledTimes(964);
      expect(vi.mocked(mockGL.bufferData).mock.calls.filter(([, data]) => typeof data === 'number')).toEqual([]);
      expect(renderer['instanceCapacityBytes']).toBe(64 * 1024);
      expect(renderer['instanceStaging'].length).toBe((64 * 1024) / 4);
      render(renderer, ...commands(964));
      expect(warn).toHaveBeenCalledTimes(1);
      // A smaller frame batches again.
      vi.clearAllMocks();
      render(renderer, ...commands(2));
      expect(instancedDraws()).toEqual([[6, mockGL.UNSIGNED_SHORT, 2]]);
    });
  });
});

describe('detectWebGL2Features', () => {
  it('detects core WebGL2 features', () => {
    const gl = createComprehensiveMockGL();
    const features = detectWebGL2Features(gl);
    expect(features.webgl2).toBe(true);
    expect(features.textureArrays).toBe(true);
    expect(features.uniformBuffers).toBe(true);
    expect(features.vertexArrayObjects).toBe(true);
  });

  it('detects max texture size', () => {
    const gl = createComprehensiveMockGL();
    const features = detectWebGL2Features(gl);
    expect(features.maxTextureSize).toBeGreaterThan(0);
  });

  it('detects max texture array layers', () => {
    const gl = createComprehensiveMockGL();
    const features = detectWebGL2Features(gl);
    expect(features.maxTextureArrayLayers).toBeGreaterThan(0);
  });

  it('detects multi-draw extension', () => {
    const gl = createComprehensiveMockGL();
    const features = detectWebGL2Features(gl);
    expect(features.multiDraw).toBe(true);
  });

  it('detects anisotropic filtering', () => {
    const gl = createComprehensiveMockGL();
    const features = detectWebGL2Features(gl);
    expect(features.anisotropicFiltering).toBe(true);
    expect(features.maxAnisotropy).toBeGreaterThan(0);
  });
});

describe('isUsableWebGL2Context', () => {
  it('accepts a WebGL2 context with the methods the renderer calls', () => {
    expect(isUsableWebGL2Context(createComprehensiveMockGL())).toBe(true);
  });

  it('accepts a forwarding wrapper that is not a WebGL2RenderingContext instance', () => {
    const wrapper = { ...(createComprehensiveMockGL() as unknown as Record<string, unknown>) };
    expect(wrapper instanceof MockWebGL2RenderingContext).toBe(false);
    expect(isUsableWebGL2Context(wrapper)).toBe(true);
  });

  it.each([null, undefined, {}, 'webgl2'])('rejects %s', (value) => {
    expect(isUsableWebGL2Context(value)).toBe(false);
  });

  it('rejects a lookalike missing a method the renderer calls', () => {
    const { viewport: _viewport, ...lookalike } = createComprehensiveMockGL() as unknown as Record<string, unknown>;
    expect(isUsableWebGL2Context(lookalike)).toBe(false);
  });
});

describe('isWebGL2Available', () => {
  it('returns boolean', () => {
    const result = isWebGL2Available();
    expect(typeof result).toBe('boolean');
  });
});
