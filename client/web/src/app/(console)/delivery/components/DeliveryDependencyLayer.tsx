"use client";

import { Fragment, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { DeliveryBoardColumn } from "@/api/delivery.api";

interface DeliveryDependencyLayerProps {
  boardRef: RefObject<HTMLDivElement>;
  columns: DeliveryBoardColumn[];
	scale: number;
  activeItemKey?: string;
  draftPath?: string;
  onDeleteDependency: (predecessorItemKey: string, successorItemKey: string) => void;
}

interface DependencyPath {
  id: string;
  from: string;
  to: string;
  d: string;
}

interface LayerSize {
  width: number;
  height: number;
}

type TargetSide = "top" | "right" | "bottom" | "left";

/** 卡片相对画布的布局坐标：只累加 offset，不受祖先 transform 影响。 */
interface BoxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 打开动画期间逐帧复算的时长：覆盖 antd 弹窗/抽屉的展开动画。 */
const SETTLE_WINDOW_MS = 500;
/** 画布迟迟排不出版时的兜底重试上限，避免空面板一直空转 rAF。 */
const READY_TIMEOUT_MS = 3000;

const ZERO_RECT: BoxRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

function toBoxRect(left: number, top: number, width: number, height: number): BoxRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/**
 * 画布内元素的布局坐标。弹窗打开时 antd 的缩放动画会给祖先加 transform，
 * getBoundingClientRect 量到的是动画中途的尺寸，连线会被压到卡片底下看不见，
 * 一直要等下一次数据刷新重算才显形；沿 offsetParent 累加则始终是布局坐标。
 */
function layoutRect(element: HTMLElement, board: HTMLElement): BoxRect {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== board) {
    left += node.offsetLeft;
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent) {
      // 链路没落到画布上（比如中途 position: fixed），退回视口坐标做差。
      const elementRect = element.getBoundingClientRect();
      const boardRect = board.getBoundingClientRect();
      return toBoxRect(
        elementRect.left - boardRect.left,
        elementRect.top - boardRect.top,
        elementRect.width,
        elementRect.height,
      );
    }
    node = parent;
  }
  return toBoxRect(left, top, element.offsetWidth, element.offsetHeight);
}

function pathBetween(source: BoxRect, target: BoxRect, board: BoxRect, scale: number, savedSourceSide?: string, savedTargetSide?: string) {
  const sourceCenterX = source.left - board.left + source.width / 2;
  const targetCenterX = target.left - board.left + target.width / 2;
  const sourceCenterY = source.top - board.top + source.height / 2;
  const targetCenterY = target.top - board.top + target.height / 2;
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;
  const automaticTargetSide: TargetSide = Math.abs(deltaX) >= Math.abs(deltaY)
    ? (deltaX >= 0 ? "left" : "right")
    : (deltaY >= 0 ? "top" : "bottom");
	const automaticSourceSide: TargetSide = Math.abs(deltaX) >= Math.abs(deltaY)
		? (deltaX >= 0 ? "right" : "left")
		: (deltaY >= 0 ? "bottom" : "top");
	const sourceSide: TargetSide = ["top", "right", "bottom", "left"].includes(savedSourceSide ?? "")
		? savedSourceSide as TargetSide
		: automaticSourceSide;
  const targetSide: TargetSide = ["top", "right", "bottom", "left"].includes(savedTargetSide ?? "")
    ? savedTargetSide as TargetSide
    : automaticTargetSide;
	const sourceAnchor = {
		top: [sourceCenterX, source.top - board.top],
		right: [source.right - board.left, sourceCenterY],
		bottom: [sourceCenterX, source.bottom - board.top],
		left: [source.left - board.left, sourceCenterY],
	}[sourceSide];
	const [startX, startY] = sourceAnchor;
  const targetAnchor = {
    top: [targetCenterX, target.top - board.top],
    right: [target.right - board.left, targetCenterY],
    bottom: [targetCenterX, target.bottom - board.top],
    left: [target.left - board.left, targetCenterY],
  }[targetSide];
  const [endX, endY] = targetAnchor;
  const bend = Math.max(36 * scale, Math.max(Math.abs(endX - startX), Math.abs(endY - startY)) * 0.35);
  const targetControl = {
    top: [endX, endY - bend],
    right: [endX + bend, endY],
    bottom: [endX, endY + bend],
    left: [endX - bend, endY],
  }[targetSide];
	const sourceControl = {
		top: [startX, startY - bend],
		right: [startX + bend, startY],
		bottom: [startX, startY + bend],
		left: [startX - bend, startY],
	}[sourceSide];
	return `M ${startX} ${startY} C ${sourceControl[0]} ${sourceControl[1]}, ${targetControl[0]} ${targetControl[1]}, ${endX} ${endY}`;
}

export function DeliveryDependencyLayer({
  boardRef,
  columns,
	scale,
  activeItemKey,
  draftPath,
  onDeleteDependency,
}: DeliveryDependencyLayerProps) {
  const [paths, setPaths] = useState<DependencyPath[]>([]);
  const [size, setSize] = useState<LayerSize>({ width: 0, height: 0 });
  // 画布 ref 挂在父级节点上，而子组件的 layout effect 比父级 host 节点的 ref 赋值更早，
  // 首次挂载时 boardRef.current 还是 null。这里用每次渲染后跑的 passive effect 把画布同步进
  // 状态，拿到之后再量算；否则连线要等下一次 columns 变化（进度窗 10s 轮询）才出现。
  const [board, setBoard] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (boardRef.current !== board) setBoard(boardRef.current);
  });

  useLayoutEffect(() => {
    if (!board) return;

    let frame = 0;
    let readyDeadline = 0;
    let settleUntil = 0;
    let signature = "";

    const collect = () => {
      const cards = new Map<string, BoxRect>();
      board.querySelectorAll<HTMLElement>("[data-delivery-item-key]").forEach((element) => {
        const itemKey = element.dataset.deliveryItemKey;
        if (itemKey) cards.set(itemKey, layoutRect(element, board));
      });

      const nextPaths: DependencyPath[] = [];
      columns.forEach((column) => {
        column.items.forEach((item) => {
          const target = cards.get(item.itemKey);
          if (!target) return;
          (item.dependsOnItemKeys ?? []).forEach((predecessorItemKey) => {
            const source = cards.get(predecessorItemKey);
            if (!source) return;
            nextPaths.push({
              id: `${predecessorItemKey}->${item.itemKey}`,
              from: predecessorItemKey,
              to: item.itemKey,
              d: pathBetween(
                source,
                target,
                ZERO_RECT,
                scale,
                item.dependencySourceSides?.[predecessorItemKey],
                item.dependencyTargetSides?.[predecessorItemKey],
              ),
            });
          });
        });
      });

      const width = board.scrollWidth;
      const height = board.scrollHeight;
      // 画布还没排好版（弹窗刚挂载、祖先还没显示）时量到的全是 0，
      // 这时候提交等于把连线画进 0×0 的视口里，看不见。
      const ready = width > 0 && height > 0
        && Array.from(cards.values()).every((rect) => rect.width > 0 && rect.height > 0);
      return { paths: nextPaths, width, height, ready };
    };

    const run = () => {
      frame = 0;
      const result = collect();
      const nextSignature = `${result.width}x${result.height}|${result.paths.map((path) => `${path.id}:${path.d}`).join("|")}`;
      if (result.ready && nextSignature !== signature) {
        signature = nextSignature;
        setSize({ width: result.width, height: result.height });
        setPaths(result.paths);
      }
      const now = performance.now();
      // 弹窗、抽屉展开的那几百毫秒里布局还在变，而这些变化不一定触发 ResizeObserver，
      // 所以先逐帧复算一小段；否则连线要等下一次数据刷新（轮询 10s）才显形。
      if ((!result.ready && now < readyDeadline) || now < settleUntil) {
        frame = requestAnimationFrame(run);
      }
    };

    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      const now = performance.now();
      readyDeadline = now + READY_TIMEOUT_MS;
      settleUntil = now + SETTLE_WINDOW_MS;
      run();
    };

    // 首帧同步量一次：卡片和连线同一次绘制出现，不再差一帧。
    measure();
    // 尺寸变化走下一帧，避免在 ResizeObserver 回调里同步改状态触发 loop 警告。
    const scheduleMeasure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(board);
    board.querySelectorAll<HTMLElement>("[data-delivery-item-key]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [board, columns, scale]);

  return (
    <svg
      aria-hidden="true"
      className={`delivery-dependency-layer${activeItemKey ? " has-active-item" : ""}`}
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
    >
      <defs>
				<marker id="delivery-dependency-arrow" markerUnits="userSpaceOnUse" markerWidth={7 * scale} markerHeight={7 * scale} refX="6" refY="3.5" viewBox="0 0 7 7" orient="auto">
          <path d="M 0 0 L 7 3.5 L 0 7 z" />
        </marker>
      </defs>
      {paths.map((path) => {
        const active = activeItemKey === path.from || activeItemKey === path.to;
        return (
          <Fragment key={path.id}>
            <path
              className="delivery-dependency-hit-area"
              d={path.d}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDeleteDependency(path.from, path.to);
              }}
            />
            <path
              className={`delivery-dependency-line${active ? " is-active" : ""}`}
              d={path.d}
              markerEnd="url(#delivery-dependency-arrow)"
            />
          </Fragment>
        );
      })}
      {draftPath ? (
        <path
          className="delivery-dependency-line is-preview"
          d={draftPath}
          markerEnd="url(#delivery-dependency-arrow)"
        />
      ) : null}
    </svg>
  );
}
