"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useLocale } from "@/i18n/LocaleProvider";
import type {
  DeliveryModuleProgress,
  DeliveryRequirementRecord,
  DeliveryStageProgress,
} from "@/api/delivery.api";

export type PanoramaLayout = "module" | "stage";

/** 原型 assets/data.js 的 C 常量，原样搬过来 —— 三维里的颜色以它为准。 */
const C = {
  red: 0xf43f5e,
  amber: 0xfbbf24,
  green: 0x34d399,
  cyan: 0x22d3ee,
  gray: 0x46536e,
  slate: 0x5d6f95,
};

const REQUIREMENT_HEX: Record<string, number> = {
  open: C.cyan,
  done: C.green,
  dropped: C.gray,
};

export interface PanoramaPick {
  kind: "node" | "requirement" | "core";
  key: string;
  name?: string;
}

/** 需求尚未指定模块时，也必须留在全景中，不能被静默丢掉。 */
export const PANORAMA_UNASSIGNED_MODULE_KEY = "__pano_unassigned_module__";
export const PANORAMA_UNASSIGNED_STAGE_KEY = "__pano_unassigned_stage__";

export function panoramaRequirementGroupKey(
  requirement: DeliveryRequirementRecord,
  layout: PanoramaLayout,
): string {
  return layout === "module"
    ? requirement.moduleKey || PANORAMA_UNASSIGNED_MODULE_KEY
    : requirement.stageKey || PANORAMA_UNASSIGNED_STAGE_KEY;
}

interface PanoramaNode {
  key: string;
  name: string;
  subtitle: string;
  /** 0-100 */
  progress: number;
  weight: number;
  kind: string;
  total: number;
  doneCount: number;
  /** 需求绕所属模块公转。 */
  orbitRequirements: DeliveryRequirementRecord[];
}

interface PanoramaStageProps {
  layout: PanoramaLayout;
  modules: DeliveryModuleProgress[];
  stages: DeliveryStageProgress[];
  requirements: DeliveryRequirementRecord[];
  maturityScore: number;
  selectedKey?: string;
  /** 右侧详情面板是否展开。展开时把三维画面整体左推，别让球躲在面板底下。 */
  panelOpen?: boolean;
  /** 双击聚焦的节点。由外层控制，聚焦条上的「返回全景」把它清掉。 */
  focusKey?: string;
  onPick?: (pick: PanoramaPick) => void;
  onFocus?: (pick: PanoramaPick | null) => void;
}

/**
 * 健康度 → 颜色。对齐原型图例的三档语义：
 * 红 = 致命阻塞，琥珀 = 部分已具备，绿 = 已打通。
 *
 * 阈值按原型的观感定：只要有东西跑起来了就该转琥珀，而不是继续标红。
 */
function healthColor(health: number): number {
  if (health < 0.15) return C.red;
  if (health < 0.7) return C.amber;
  return C.green;
}

function glowTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(canvas);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}

/**
 * 三维全景 —— yinni-分析 index.html 大盘图的移植。几何、材质、相机、动效，
 * 连渲染器的色彩管线都按 assets/app.js（three r128）对齐，数据换成真实进度：
 *
 *   模块环 / 里程碑路径的分组大球 · 线框壳 r*1.5
 *   需求小球绕所属分组公转；颜色表示需求状态
 *   相邻模块之间二次贝塞尔连线，线上跑粒子：健康度 <.5 的那段会卡在中途
 *   中心正上方 y=19 的核心球是整盘成熟度，虚线轴连回环面
 *   双击球体聚焦该环节，双击空白处返回全景
 */
export function PanoramaStage({
  layout,
  modules,
  stages,
  requirements,
  maturityScore,
  selectedKey,
  panelOpen,
  focusKey,
  onPick,
  onFocus,
}: PanoramaStageProps) {
  const { t } = useLocale();
  const mountRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<((pick: PanoramaPick) => void) | undefined>(onPick);
  const focusCallbackRef = useRef<((pick: PanoramaPick | null) => void) | undefined>(onFocus);
  const selectedRef = useRef<string | undefined>(selectedKey);
  const focusRef = useRef<string | undefined>(focusKey);
  const panelRef = useRef<boolean>(Boolean(panelOpen));

  pickRef.current = onPick;
  focusCallbackRef.current = onFocus;
  selectedRef.current = selectedKey;
  focusRef.current = focusKey;
  panelRef.current = Boolean(panelOpen);

  const nodes = useMemo<PanoramaNode[]>(() => {
    if (layout === "stage") {
      return stages.map((stage) => ({
        key: stage.stageKey,
        name: stage.tag || stage.stageKey,
        subtitle: `${stage.maturityLevel} · ${stage.doneCount}/${stage.total}`,
        progress: stage.progress,
        weight: 18,
        kind: "",
        total: stage.total,
        doneCount: stage.doneCount,
        orbitRequirements: requirements.filter(
          (requirement) => panoramaRequirementGroupKey(requirement, layout) === stage.stageKey,
        ),
      }));
    }
    return modules.map((module) => ({
      key: module.moduleKey,
      name: module.name || module.moduleKey,
      subtitle: `${t("delivery.panorama.weight")} ${module.weight}% · ${module.doneCount}/${module.total}`,
      progress: module.progress,
      weight: module.weight,
      kind: module.kind,
      total: module.total,
      doneCount: module.doneCount,
      orbitRequirements: requirements.filter(
        (requirement) => panoramaRequirementGroupKey(requirement, layout) === module.moduleKey,
      ),
    }));
  }, [layout, modules, requirements, stages, t]);

  const nodesRef = useRef(nodes);
  const tRef = useRef(t);
  nodesRef.current = nodes;
  tRef.current = t;

  /**
   * 场景重建的唯一触发条件。
   *
   * 之前用 [nodes, requirements, t] 当依赖，看着合理，实际是个坑：ManagerShell
   * 顶栏的时钟每秒 setState 一次，整棵子树跟着重渲染，useLocale 的 t 又是每次
   * 新函数，于是 nodes 这个 memo 每秒换一次身份 —— 场景每秒被拆了重建，
   * 聚焦淡出的 alpha 还没降下来就被重置成 1，看起来就是「双击没反应」。
   *
   * 改成按内容算一个签名：真正的数据变了才重建，父组件重渲染一概不管。
   */
  const sceneKey = useMemo(
    () =>
      JSON.stringify({
        layout,
        locale: t("delivery.panorama.heroTitle"),
        maturity: Math.round(maturityScore),
        modules: modules.map((m) => [m.moduleKey, m.weight, m.progress, m.total, m.doneCount, m.kind]),
        stages: stages.map((s) => [s.stageKey, s.tag, s.progress, s.total, s.doneCount, s.maturityLevel]),
        requirements: requirements.map((r) => [
          r.requirementKey,
          r.name,
          r.status,
          r.moduleKey,
          r.stageKey,
          r.itemCount,
        ]),
      }),
    [layout, maturityScore, modules, requirements, stages, t],
  );

  useEffect(() => {
    const mount = mountRef.current;
    const labelLayer = labelLayerRef.current;
    if (!mount || !labelLayer) return undefined;

    const size = { width: mount.clientWidth || 960, height: mount.clientHeight || 560 };

    // ★ 观感的大头在这三行。原型跑在 three r128：没有颜色管理、线性输出、
    // 光照按旧的非物理单位。r152+ 把这三样的默认值全改了，同一套参数渲出来
    // 会发灰发暗、失掉通透感。调回 r128 的行为，才谈得上「和原型一致」。
    THREE.ColorManagement.enabled = false;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060912, 0.011);

    const camera = new THREE.PerspectiveCamera(48, size.width / size.height, 0.1, 600);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.useLegacyLights = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size.width, size.height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const keyLight = new THREE.PointLight(0x88bbff, 1.1, 300);
    keyLight.position.set(25, 35, 30);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(C.cyan, 0.7, 240);
    rimLight.position.set(-30, -12, -25);
    scene.add(rimLight);

    // 星尘：球壳分布，压扁 y 轴
    const dustGeometry = new THREE.BufferGeometry();
    const dustCount = 1200;
    const dust = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
      const radius = 70 + Math.random() * 130;
      const theta = Math.random() * 6.283;
      const phi = Math.acos(2 * Math.random() - 1);
      dust[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      dust[i * 3 + 1] = radius * Math.cos(phi) * 0.6;
      dust[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(dust, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: 0x8fa8d8,
      size: 0.35,
      transparent: true,
      opacity: 0.45,
    });
    scene.add(new THREE.Points(dustGeometry, dustMaterial));

    const glow = glowTexture();
    const disposables: { dispose: () => void }[] = [dustGeometry, dustMaterial, glow];
    const pickables: THREE.Mesh[] = [];
    const labels: {
      object: THREE.Object3D;
      element: HTMLDivElement;
      offset: THREE.Vector3;
      small: boolean;
      /** 属于哪个环节。聚焦时只留本环节的小标签，否则一屏几十条名字糊死。 */
      owner?: string;
    }[] = [];

    const board = new THREE.Group();
    scene.add(board);

    /** 原型的 ball()：主体 + 加色混合的光晕 sprite。 */
    const ball = (radius: number, color: number, opacity = 0.93) => {
      const geometry = new THREE.IcosahedronGeometry(radius, 3);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.25,
        transparent: true,
        opacity,
      });
      const mesh = new THREE.Mesh(geometry, material);
      const haloMaterial = new THREE.SpriteMaterial({
        map: glow,
        color,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.setScalar(radius * 3);
      mesh.add(halo);
      disposables.push(geometry, material, haloMaterial);
      return mesh;
    };

    const addLabel = (
      object: THREE.Object3D,
      html: string,
      className: string,
      offset: THREE.Vector3,
      owner?: string,
    ) => {
      const element = document.createElement("div");
      element.className = `pano-lbl${className ? ` ${className}` : ""}`;
      element.innerHTML = html;
      labelLayer.appendChild(element);
      labels.push({ object, element, offset, small: className.includes("sm"), owner });
      return element;
    };

    const nodes = nodesRef.current;
    const t = tRef.current;

    const RING = 21;
    const positions = new Map<string, THREE.Vector3>();
    const orbiters: {
      mesh: THREE.Mesh;
      ang: number;
      rr: number;
      y: number;
      speed: number;
    }[] = [];
    const shells: THREE.Mesh[] = [];
    const nodeGroups: {
      key: string;
      group: THREE.Group;
      base: THREE.Vector3;
      /** 组内所有材质 + 原始不透明度，聚焦时按 alpha 整组淡出 */
      fades: { material: THREE.Material & { opacity: number }; base: number }[];
      alpha: number;
    }[] = [];
    // 连线、辐条、粒子、核心球：聚焦时整体淡出，只留被聚焦的那一组
    const ambient: { object: THREE.Object3D; material: THREE.Material & { opacity: number }; base: number }[] = [];

    const collectFades = (root: THREE.Object3D) => {
      const found: { material: THREE.Material & { opacity: number }; base: number }[] = [];
      root.traverse((child) => {
        const material = (child as THREE.Mesh | THREE.Sprite).material as
          | (THREE.Material & { opacity: number })
          | undefined;
        if (material && "opacity" in material) found.push({ material, base: material.opacity });
      });
      return found;
    };

    // ---- 模块环 / 里程碑路径上的分组节点 ----
    nodes.forEach((node, index) => {
      const position = layout === "module"
        ? (() => {
            const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
            return new THREE.Vector3(
              Math.cos(angle) * RING,
              Math.sin(index * 1.7) * 1.1,
              Math.sin(angle) * RING,
            );
          })()
        : new THREE.Vector3(
            -20 + (index / Math.max(nodes.length - 1, 1)) * 40,
            (node.progress / 100) * 10 - 4,
            0,
          );
      positions.set(node.key, position);

      const radius = layout === "module" ? 2.1 + Math.min(node.weight, 40) * 0.04 : 2.7;
      const color = node.total === 0 ? C.gray : healthColor(node.progress / 100);

      const group = new THREE.Group();
      group.position.copy(position);
      board.add(group);

      const mesh = ball(radius, color);
      mesh.userData = { kind: "node", key: node.key, name: node.name };
      group.add(mesh);
      pickables.push(mesh);

      const shellGeometry = new THREE.IcosahedronGeometry(radius * 1.5, 1);
      const shellMaterial = new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.2,
      });
      const shell = new THREE.Mesh(shellGeometry, shellMaterial);
      group.add(shell);
      shells.push(shell);
      disposables.push(shellGeometry, shellMaterial);

      const done = node.total > 0 && node.doneCount === node.total;
      addLabel(
        mesh,
        `<b>${escapeHtml(node.name)}</b><small class="${done ? "ok" : ""}">${escapeHtml(node.subtitle)} · ${Math.round(node.progress)}%</small>`,
        "",
        new THREE.Vector3(0, radius + 1.9, 0),
      );

      // 需求小球围绕所属大球公转，形成清晰的「分组 → 需求」层级。
      node.orbitRequirements.forEach((requirement, requirementIndex) => {
        const count = node.orbitRequirements.length;
        const ang = (requirementIndex / count) * Math.PI * 2 + index;
        const rr = radius + 2.5 + (requirementIndex % 3) * 1.05 + Math.floor(requirementIndex / 12) * 0.85;
        const dot = ball(0.48, REQUIREMENT_HEX[requirement.status] ?? C.slate, requirement.status === "open" ? 0.9 : 0.72);
        dot.userData = { kind: "requirement", key: requirement.requirementKey, name: requirement.name || requirement.requirementKey };
        group.add(dot);
        pickables.push(dot);
        orbiters.push({
          mesh: dot,
          ang,
          rr,
          y: ((requirementIndex % 3) - 1) * 1.15,
          speed: 0.07 + requirementIndex * 0.01,
        });
        addLabel(
          dot,
          escapeHtml(requirement.name || requirement.requirementKey),
          `sm${requirement.status === "done" ? " done" : ""}`,
          new THREE.Vector3(0, 0.95, 0),
          node.key,
        );
      });

      // 组装完再登记：collectFades 要把组里的小球材质一起收进来
      nodeGroups.push({
        key: node.key,
        group,
        base: position.clone(),
        fades: collectFades(group),
        alpha: 1,
      });
    });

    // ---- 连线 + 流动粒子 ----
    const flows: { curve: THREE.QuadraticBezierCurve3; health: number }[] = [];
    if (layout === "module") {
      nodes.forEach((node, index) => {
        const next = nodes[(index + 1) % nodes.length];
        const from = positions.get(node.key);
        const to = positions.get(next?.key ?? "");
        if (!from || !to || nodes.length < 2) return;
        const mid = from.clone().add(to).multiplyScalar(0.5);
        mid.y += 3.4;
        mid.multiplyScalar(0.86);
        const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
        const health = Math.min(node.progress, next.progress) / 100;
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(60));
        const lineMaterial = new THREE.LineBasicMaterial({
          color: healthColor(health),
          transparent: true,
          opacity: 0.4,
        });
        const link = new THREE.Line(lineGeometry, lineMaterial);
        board.add(link);
        ambient.push({ object: link, material: lineMaterial, base: lineMaterial.opacity });
        disposables.push(lineGeometry, lineMaterial);
        flows.push({ curve, health });
      });

      nodes.forEach((node) => {
        const to = positions.get(node.key);
        if (!to) return;
        const spokeGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to.clone()]);
        const spokeMaterial = new THREE.LineDashedMaterial({
          color: C.gray,
          transparent: true,
          opacity: 0.3,
          dashSize: 0.9,
          gapSize: 0.7,
        });
        const spoke = new THREE.Line(spokeGeometry, spokeMaterial);
        spoke.computeLineDistances();
        board.add(spoke);
        ambient.push({ object: spoke, material: spokeMaterial, base: spokeMaterial.opacity });
        disposables.push(spokeGeometry, spokeMaterial);
      });
    } else {
      nodes.forEach((node, index) => {
        if (index === 0) return;
        const from = positions.get(nodes[index - 1].key);
        const to = positions.get(node.key);
        if (!from || !to) return;
        const mid = from.clone().add(to).multiplyScalar(0.5);
        mid.y += 2.2;
        const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
        const health = nodes[index - 1].progress / 100;
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(60));
        const lineMaterial = new THREE.LineBasicMaterial({
          color: healthColor(health),
          transparent: true,
          opacity: 0.45,
        });
        const link = new THREE.Line(lineGeometry, lineMaterial);
        board.add(link);
        ambient.push({ object: link, material: lineMaterial, base: lineMaterial.opacity });
        disposables.push(lineGeometry, lineMaterial);
        flows.push({ curve, health });
      });
    }

    const PER_LINE = 26;
    let flowPoints: THREE.Points | null = null;
    const flowProgress = new Float32Array(flows.length * PER_LINE).map(() => Math.random());
    if (flows.length > 0) {
      const flowGeometry = new THREE.BufferGeometry();
      flowGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(flows.length * PER_LINE * 3), 3),
      );
      flowGeometry.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(flows.length * PER_LINE * 3), 3),
      );
      const flowMaterial = new THREE.PointsMaterial({
        size: 0.42,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      flowPoints = new THREE.Points(flowGeometry, flowMaterial);
      board.add(flowPoints);
      ambient.push({ object: flowPoints, material: flowMaterial, base: flowMaterial.opacity });
      disposables.push(flowGeometry, flowMaterial);
    }

    // ---- 核心球：整盘成熟度 ----
    let core: THREE.Mesh | null = null;
    core = ball(1.9, healthColor(maturityScore / 100), 0.5);
    core.position.set(0, 19, 0);
    core.userData = { kind: "core", key: "__core__" };
    board.add(core);
    pickables.push(core);
    collectFades(core).forEach((entry) =>
      ambient.push({ object: core as THREE.Object3D, material: entry.material, base: entry.base }),
    );
    addLabel(
      core,
      `<b>${Math.round(maturityScore)}%</b><small>${escapeHtml(t("delivery.kpi.maturity"))}</small>`,
      "",
      new THREE.Vector3(0, 3.1, 0),
    );

    const axisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 17.2, 0),
      new THREE.Vector3(0, 4.2, 0),
    ]);
    const axisMaterial = new THREE.LineDashedMaterial({
      color: C.gray,
      transparent: true,
      opacity: 0.35,
      dashSize: 0.7,
      gapSize: 0.6,
    });
    const axis = new THREE.Line(axisGeometry, axisMaterial);
    axis.computeLineDistances();
    board.add(axis);
    ambient.push({ object: axis, material: axisMaterial, base: axisMaterial.opacity });
    disposables.push(axisGeometry, axisMaterial);

    // ---- 相机与交互 ----
    const cam = { r: 60, theta: 0.6, phi: 1.14, target: new THREE.Vector3() };
    const camTarget = {
      r: layout === "module" ? 60 : 52,
      theta: 0.6,
      phi: 1.14,
      target: new THREE.Vector3(),
    };
    const origin = new THREE.Vector3();
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    const pointer = new THREE.Vector2(-2, -2);
    const raycaster = new THREE.Raycaster();
    let hovered: THREE.Object3D | null = null;

    const setPointer = (event: PointerEvent | MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };
    // 隐藏的球不该还能被点到 —— Raycaster 不看祖先的 visible，得自己过滤
    const worldVisible = (object: THREE.Object3D) => {
      let node: THREE.Object3D | null = object;
      while (node) {
        if (!node.visible) return false;
        node = node.parent;
      }
      return true;
    };
    const visiblePickables = () => pickables.filter(worldVisible);
    const hitAt = (event: MouseEvent) => {
      setPointer(event);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(visiblePickables(), false)[0]?.object ?? null;
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      moved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (dragging) {
        moved += Math.abs(dx) + Math.abs(dy);
        camTarget.theta -= dx * 0.005;
        camTarget.phi = Math.max(0.25, Math.min(Math.PI - 0.25, camTarget.phi - dy * 0.004));
      }
      lastX = event.clientX;
      lastY = event.clientY;
      setPointer(event);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      camTarget.r = Math.max(12, Math.min(130, camTarget.r + event.deltaY * 0.03));
    };
    const onClick = (event: MouseEvent) => {
      if (moved > 6) return;
      const object = hitAt(event);
      if (object) {
        const data = object.userData as PanoramaPick;
        pickRef.current?.({ kind: data.kind, key: data.key, name: data.name });
      }
    };
    // 双击大球 → 单独放大该环节；双击空白 → 回全景。原型的 focus 模式。
    const onDoubleClick = (event: MouseEvent) => {
      const object = hitAt(event);
      const data = object?.userData as PanoramaPick | undefined;
      if (data?.kind === "node") {
        focusCallbackRef.current?.({ kind: "node", key: data.key, name: data.name });
      } else {
        focusCallbackRef.current?.(null);
      }
    };

    const element = renderer.domElement;
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("click", onClick);
    element.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);

    // ---- 循环 ----
    const clock = new THREE.Clock();
    let viewOffset = 0;
    let ambientAlpha = 1;
    const projected = new THREE.Vector3();
    const worldPosition = new THREE.Vector3();
    const tempColor = new THREE.Color();
    let frame = 0;

    const render = () => {
      frame = window.requestAnimationFrame(render);
      const time = clock.getElapsedTime();
      const focused = focusRef.current;

      raycaster.setFromCamera(pointer, camera);
      hovered = raycaster.intersectObjects(visiblePickables(), false)[0]?.object ?? null;
      element.style.cursor = hovered ? "pointer" : dragging ? "grabbing" : "grab";

      // 聚焦时停自转，否则被聚焦的球会自己转出视野
      if (!focused) board.rotation.y = time * 0.028;

      shells.forEach((shell, index) => {
        shell.rotation.y = time * (0.28 + index * 0.05);
        shell.rotation.x = time * 0.14;
      });
      // 聚焦：被选中的那一组放大留下，其余的环节、连线、粒子、核心球淡出隐藏
      nodeGroups.forEach((entry, index) => {
        entry.group.position.y = entry.base.y + Math.sin(time * 0.8 + index) * 0.25;
        const kept = !focused || entry.key === focused;
        const want = focused === entry.key ? 1.35 : 1;
        entry.group.scale.setScalar(entry.group.scale.x + (want - entry.group.scale.x) * 0.1);

        entry.alpha += ((kept ? 1 : 0) - entry.alpha) * 0.14;
        entry.group.visible = entry.alpha > 0.02;
        if (entry.alpha < 0.999) {
          entry.fades.forEach((fade) => {
            fade.material.opacity = fade.base * entry.alpha;
          });
        }
      });

      ambientAlpha += ((focused ? 0 : 1) - ambientAlpha) * 0.14;
      ambient.forEach((entry) => {
        entry.object.visible = ambientAlpha > 0.02;
        entry.material.opacity = entry.base * ambientAlpha;
      });

      orbiters.forEach((orbit) => {
        const ang = orbit.ang + time * orbit.speed;
        orbit.mesh.position.set(
          Math.cos(ang) * orbit.rr,
          orbit.y + Math.sin(time * 0.9 + orbit.ang) * 0.3,
          Math.sin(ang) * orbit.rr,
        );
      });
      if (core) core.rotation.y = time * 0.3;

      pickables.forEach((mesh) => {
        if ((mesh.userData.kind as string) === "requirement") return;
        const active = selectedRef.current === (mesh.userData.key as string);
        const want = (active ? 1.22 : 1) * (hovered === mesh ? 1.22 : 1);
        mesh.scale.setScalar(mesh.scale.x + (want - mesh.scale.x) * 0.12);
      });

      if (flowPoints) {
        const positionsAttr = flowPoints.geometry.attributes.position.array as Float32Array;
        const colorsAttr = flowPoints.geometry.attributes.color.array as Float32Array;
        flows.forEach((flow, lineIndex) => {
          const stuck = flow.health < 0.5;
          tempColor.setHex(healthColor(flow.health));
          for (let k = 0; k < PER_LINE; k += 1) {
            const index = lineIndex * PER_LINE + k;
            flowProgress[index] += stuck ? 0.0006 : 0.0016 + flow.health * 0.0026;
            if (flowProgress[index] > 1) flowProgress[index] = stuck ? 0.42 : 0;
            let u = flowProgress[index];
            if (stuck) u = Math.min(u, 0.48 + Math.sin(time * 2 + k) * 0.02);
            flow.curve.getPoint(u, projected);
            positionsAttr[index * 3] = projected.x;
            positionsAttr[index * 3 + 1] = projected.y;
            positionsAttr[index * 3 + 2] = projected.z;
            colorsAttr[index * 3] = tempColor.r;
            colorsAttr[index * 3 + 1] = tempColor.g;
            colorsAttr[index * 3 + 2] = tempColor.b;
          }
        });
        flowPoints.geometry.attributes.position.needsUpdate = true;
        flowPoints.geometry.attributes.color.needsUpdate = true;
      }

      // 聚焦：相机盯住那个球并拉近
      const focusEntry = focused ? nodeGroups.find((entry) => entry.key === focused) : undefined;
      if (focusEntry) {
        focusEntry.group.getWorldPosition(worldPosition);
        camTarget.target.lerp(worldPosition, 0.15);
        camTarget.r += (22 - camTarget.r) * 0.12;
      } else {
        camTarget.target.lerp(origin, 0.12);
      }

      // 面板占掉右侧 400px，用 setViewOffset 把可视中心左移，
      // 效果等于「相机往右挪」，但不用动 target，聚焦逻辑不受影响。
      const offset = panelRef.current && size.width >= 900 ? 400 : 0;
      if (offset !== viewOffset) {
        viewOffset = offset;
        if (offset > 0) {
          camera.aspect = (size.width + offset) / size.height;
          camera.setViewOffset(size.width + offset, size.height, 0, 0, size.width, size.height);
        } else {
          camera.aspect = size.width / size.height;
          camera.clearViewOffset();
        }
        camera.updateProjectionMatrix();
      }

      cam.r += (camTarget.r - cam.r) * 0.08;
      cam.theta += (camTarget.theta - cam.theta) * 0.08;
      cam.phi += (camTarget.phi - cam.phi) * 0.08;
      cam.target.lerp(camTarget.target, 0.08);
      camera.position.set(
        cam.target.x + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta),
        cam.target.y + cam.r * Math.cos(cam.phi),
        cam.target.z + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
      );
      camera.lookAt(cam.target);
      renderer.render(scene, camera);

      labels.forEach((label) => {
        label.object.getWorldPosition(projected);
        projected.add(label.offset);
        const distance = projected.distanceTo(camera.position);
        projected.project(camera);
        if (projected.z >= 1) {
          label.element.style.opacity = "0";
          return;
        }
        if (!worldVisible(label.object)) {
          label.element.style.display = "none";
          return;
        }
        let opacity = 1;
        if (label.small) {
          if (focused) {
            // 聚焦时只留本环节的小标签，别的环节一律收起
            opacity = label.owner === focused ? 1 : 0;
          } else {
            // 只让最靠前的一批任务名亮起来。原型是整屏画布、球分得开，
            // 这里嵌在控制台里视口小得多，用原型的 .68/.55 会糊成一片。
            opacity = Math.min(1, Math.max(0, 1 - (distance - cam.r * 0.52) / (cam.r * 0.26)));
            if (hovered === label.object) opacity = 1;
          }
        }
        label.element.style.display = opacity < 0.06 ? "none" : "block";
        label.element.style.opacity = String(opacity);
        label.element.style.left = `${(projected.x * 0.5 + 0.5) * size.width}px`;
        label.element.style.top = `${(-projected.y * 0.5 + 0.5) * size.height}px`;
      });
    };
    render();

    const observer = new ResizeObserver(() => {
      size.width = mount.clientWidth || size.width;
      size.height = mount.clientHeight || size.height;
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      renderer.setSize(size.width, size.height);
    });
    observer.observe(mount);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("click", onClick);
      element.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      labels.forEach((label) => label.element.remove());
      disposables.forEach((item) => item.dispose());
      renderer.dispose();
      if (element.parentElement === mount) mount.removeChild(element);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);

  return (
    <div className="pano-stage">
      <div className="pano-canvas" ref={mountRef} />
      <div className="pano-labels" ref={labelLayerRef} />
    </div>
  );
}
