"use client";

import { Fragment, useLayoutEffect, useState, type RefObject } from "react";
import type { DeliveryBoardColumn } from "@/api/delivery.api";

interface DeliveryDependencyLayerProps {
  boardRef: RefObject<HTMLDivElement>;
  columns: DeliveryBoardColumn[];
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

function pathBetween(source: DOMRect, target: DOMRect, board: DOMRect, savedSourceSide?: string, savedTargetSide?: string) {
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
  const bend = Math.max(36, Math.max(Math.abs(endX - startX), Math.abs(endY - startY)) * 0.35);
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
  activeItemKey,
  draftPath,
  onDeleteDependency,
}: DeliveryDependencyLayerProps) {
  const [paths, setPaths] = useState<DependencyPath[]>([]);
  const [size, setSize] = useState<LayerSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const boardRect = board.getBoundingClientRect();
        const cards = new Map<string, DOMRect>();
        board.querySelectorAll<HTMLElement>("[data-delivery-item-key]").forEach((element) => {
          const itemKey = element.dataset.deliveryItemKey;
          if (itemKey) cards.set(itemKey, element.getBoundingClientRect());
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
					boardRect,
					item.dependencySourceSides?.[predecessorItemKey],
					item.dependencyTargetSides?.[predecessorItemKey],
				),
              });
            });
          });
        });

        setSize({ width: board.scrollWidth, height: board.scrollHeight });
        setPaths(nextPaths);
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    board.querySelectorAll<HTMLElement>("[data-delivery-item-key]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [boardRef, columns]);

  return (
    <svg
      aria-hidden="true"
      className={`delivery-dependency-layer${activeItemKey ? " has-active-item" : ""}`}
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
    >
      <defs>
        <marker id="delivery-dependency-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
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
