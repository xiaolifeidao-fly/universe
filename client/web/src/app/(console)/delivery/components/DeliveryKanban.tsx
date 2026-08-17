"use client";

import { LinkOutlined, MessageOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { Button, Checkbox, Select, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
	STATUS_COLORS,
  type BoardGroupBy,
  type DeliveryBoardColumn,
	type DeliveryItemRecord,
  type DeliveryStatus,
} from "@/api/delivery.api";
import { DeliveryDependencyLayer } from "./DeliveryDependencyLayer";

interface DeliveryKanbanProps {
  groupBy: BoardGroupBy;
  columns: DeliveryBoardColumn[];
  moduleName: (moduleKey: string) => string;
  stageName: (stageKey: string) => string;
  showDependencies: boolean;
  onOpen: (item: DeliveryItemRecord) => void;
  onOpenSession: (item: DeliveryItemRecord) => void;
  onExecute: (item: DeliveryItemRecord) => void;
  canExecute: (item: DeliveryItemRecord) => boolean;
  executingItemKey: string;
	highlightedOwner: string;
	ownerOptions: Array<{ value: string; label: string }>;
	changingOwnerItemKey: string;
	onOwnerChange: (item: DeliveryItemRecord, ownerId: string) => void;
	selectedItemKeys: string[];
	onSelectionChange: (itemKeys: string[]) => void;
	/** 拖动落到别的列：按当前分列方式改阶段 / 状态 / 归属模块。 */
	onMove: (items: DeliveryItemRecord[], columnKey: string, sortOrder: number) => void | Promise<void>;
  onCreateDependency: (predecessorItemKey: string, successorItemKey: string, sourceSide: TargetSide, targetSide: TargetSide) => void;
  onDeleteDependency: (predecessorItemKey: string, successorItemKey: string) => void;
}

interface DependencyDrag {
  sourceItemKey: string;
	sourceSide: TargetSide;
  targetItemKey?: string;
  targetSide?: TargetSide;
  path: string;
}

type TargetSide = "top" | "right" | "bottom" | "left";

function dependencyPath(startX: number, startY: number, endX: number, endY: number, sourceSide: TargetSide, targetSide?: TargetSide) {
	const bend = Math.max(54, Math.max(Math.abs(endX - startX), Math.abs(endY - startY)) * 0.45);
	const sourceControl = {
		top: [startX, startY - bend],
		right: [startX + bend, startY],
		bottom: [startX, startY + bend],
		left: [startX - bend, startY],
	}[sourceSide];
  const targetControl = {
    top: [endX, endY - bend],
    right: [endX + bend, endY],
    bottom: [endX, endY + bend],
    left: [endX - bend, endY],
  }[targetSide ?? "left"];
	return `M ${startX} ${startY} C ${sourceControl[0]} ${sourceControl[1]}, ${targetControl[0]} ${targetControl[1]}, ${endX} ${endY}`;
}

function nearestTargetSide(rect: DOMRect, clientX: number, clientY: number): TargetSide {
  const distances: Array<[TargetSide, number]> = [
    ["top", Math.abs(clientY - rect.top)],
    ["right", Math.abs(clientX - rect.right)],
    ["bottom", Math.abs(clientY - rect.bottom)],
    ["left", Math.abs(clientX - rect.left)],
  ];
  distances.sort((left, right) => left[1] - right[1]);
  return distances[0][0];
}

function targetAnchor(rect: DOMRect, side: TargetSide, board: DOMRect) {
  if (side === "top") return { x: rect.left - board.left + rect.width / 2, y: rect.top - board.top };
  if (side === "right") return { x: rect.right - board.left, y: rect.top - board.top + rect.height / 2 };
  if (side === "bottom") return { x: rect.left - board.left + rect.width / 2, y: rect.bottom - board.top };
  return { x: rect.left - board.left, y: rect.top - board.top + rect.height / 2 };
}

const sourceAnchor = targetAnchor;

function dependencyTargetAt(clientX: number, clientY: number, sourceItemKey: string) {
  const element = document.elementFromPoint(clientX, clientY);
  const card = element?.closest<HTMLElement>("[data-delivery-item-key]");
  const itemKey = card?.dataset.deliveryItemKey;
  if (!itemKey || itemKey === sourceItemKey || !card) return undefined;
  return { card, side: nearestTargetSide(card.getBoundingClientRect(), clientX, clientY) };
}

function parallelItemKeys(items: DeliveryItemRecord[]) {
  const itemsByKey = new Map(items.map((item) => [item.itemKey, item]));
  const levelByKey = new Map<string, number>();
  const visiting = new Set<string>();

  const levelFor = (itemKey: string): number => {
    const cached = levelByKey.get(itemKey);
    if (cached !== undefined) return cached;
    if (visiting.has(itemKey)) return 0;

    visiting.add(itemKey);
    const item = itemsByKey.get(itemKey);
    const predecessors = item?.dependsOnItemKeys.filter((key) => itemsByKey.has(key)) ?? [];
    const level = predecessors.length === 0 ? 0 : Math.max(...predecessors.map(levelFor)) + 1;
    visiting.delete(itemKey);
    levelByKey.set(itemKey, level);
    return level;
  };

  const keysByLevel = new Map<number, string[]>();
  items.forEach((item) => {
    const level = levelFor(item.itemKey);
    keysByLevel.set(level, [...(keysByLevel.get(level) ?? []), item.itemKey]);
  });

  return new Set(Array.from(keysByLevel.values()).filter((keys) => keys.length > 1).flat());
}

export function DeliveryKanban({
  groupBy,
  columns,
  moduleName,
  stageName,
  showDependencies,
  onOpen,
  onOpenSession,
  onExecute,
	canExecute,
	executingItemKey,
	highlightedOwner,
	ownerOptions,
	changingOwnerItemKey,
	onOwnerChange,
	selectedItemKeys,
	onSelectionChange,
  onMove,
  onCreateDependency,
  onDeleteDependency,
}: DeliveryKanbanProps) {
  const { t } = useLocale();
  const boardRef = useRef<HTMLDivElement>(null);
  const [activeItemKey, setActiveItemKey] = useState<string>();
  const [dependencyDrag, setDependencyDrag] = useState<DependencyDrag>();
  const [isReordering, setIsReordering] = useState(false);
  const itemNames = useMemo(
    () => new Map(columns.flatMap((column) => column.items).map((item) => [item.itemKey, item.title])),
    [columns],
  );
  const parallelKeysByColumn = useMemo(
    () => new Map(columns.map((column) => [column.key, parallelItemKeys(column.items)])),
    [columns],
  );
	const isSelectable = (_item: DeliveryItemRecord) => true;

  const handleDragEnd = (result: DropResult) => {
    setIsReordering(false);
    const { destination, source, draggableId } = result;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;

    const items = columns.flatMap((column) => column.items);
    const draggedItem = items.find((item) => item.itemKey === draggableId);
    if (!draggedItem) return;

    // 拖动已勾选的卡片时，整组一起进入目标列；未勾选的卡片仍保持单卡拖动。
    const movedItemKeys = selectedItemKeys.includes(draggableId) ? selectedItemKeys : [draggableId];
    const movedItems = items.filter((item) => movedItemKeys.includes(item.itemKey));
    void onMove(movedItems.length > 0 ? movedItems : [draggedItem], destination.droppableId, destination.index);
  };

  useEffect(() => {
    const sourceItemKey = dependencyDrag?.sourceItemKey;
	const sourceSide = dependencyDrag?.sourceSide;
	if (!sourceItemKey || !sourceSide) return;

    const move = (event: PointerEvent) => {
      const board = boardRef.current;
      const source = board?.querySelector<HTMLElement>(`[data-delivery-item-key="${CSS.escape(sourceItemKey)}"]`);
      if (!board || !source) return;

      const boardRect = board.getBoundingClientRect();
      const sourceRect = source.getBoundingClientRect();
      const target = dependencyTargetAt(event.clientX, event.clientY, sourceItemKey);
      const targetRect = target?.card.getBoundingClientRect();
		const start = sourceAnchor(sourceRect, sourceSide, boardRect);
      const anchor = targetRect && target ? targetAnchor(targetRect, target.side, boardRect) : undefined;
      const endX = anchor?.x ?? event.clientX - boardRect.left;
      const endY = anchor?.y ?? event.clientY - boardRect.top;

		setDependencyDrag({
			sourceItemKey,
			sourceSide,
        targetItemKey: target?.card.dataset.deliveryItemKey,
        targetSide: target?.side,
			path: dependencyPath(start.x, start.y, endX, endY, sourceSide, target?.side),
      });

      const scroller = board.closest<HTMLElement>(".delivery-task-panel-scroll");
      const scrollerRect = scroller?.getBoundingClientRect();
      if (scroller && scrollerRect) {
        if (event.clientX > scrollerRect.right - 56) scroller.scrollLeft += 18;
        if (event.clientX < scrollerRect.left + 56) scroller.scrollLeft -= 18;
      }
      if (event.clientY > window.innerHeight - 48) window.scrollBy(0, 16);
      if (event.clientY < 48) window.scrollBy(0, -16);
    };

    const finish = (event: PointerEvent) => {
      const target = dependencyTargetAt(event.clientX, event.clientY, sourceItemKey);
      const targetItemKey = target?.card.dataset.deliveryItemKey;
      setDependencyDrag(undefined);
		if (targetItemKey && target) onCreateDependency(sourceItemKey, targetItemKey, sourceSide, target.side);
    };

    const cancel = () => setDependencyDrag(undefined);
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", cancelWithEscape);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancelWithEscape);
    };
	}, [dependencyDrag?.sourceItemKey, dependencyDrag?.sourceSide, onCreateDependency]);

	const startDependencyDrag = (itemKey: string, side: TargetSide, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const board = boardRef.current;
    const source = event.currentTarget.closest<HTMLElement>("[data-delivery-item-key]");
    if (!board || !source) return;

    const boardRect = board.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
	const start = sourceAnchor(sourceRect, side, boardRect);
    window.getSelection()?.removeAllRanges();
	setDependencyDrag({
		sourceItemKey: itemKey,
		sourceSide: side,
		path: dependencyPath(start.x, start.y, event.clientX - boardRect.left, event.clientY - boardRect.top, side),
	});
  };

  return (
    <DragDropContext onDragStart={() => setIsReordering(true)} onDragEnd={handleDragEnd}>
      <div className="delivery-board-scroll">
        <div className={`delivery-board${isReordering ? " is-reordering" : ""}`} ref={boardRef}>
          {showDependencies || dependencyDrag ? (
            <DeliveryDependencyLayer
              boardRef={boardRef}
              columns={showDependencies ? columns : []}
              activeItemKey={activeItemKey}
              draftPath={dependencyDrag?.path}
              onDeleteDependency={onDeleteDependency}
            />
          ) : null}
          {columns.map((column) => {
            const parallelItemKeys = parallelKeysByColumn.get(column.key) ?? new Set<string>();
            const hasParallelItems = parallelItemKeys.size > 0;
            return (
            <Droppable droppableId={column.key} key={column.key}>
              {(provided, snapshot) => (
                <section
                  className={`delivery-column${hasParallelItems ? " has-parallel-items" : ""}${snapshot.isDraggingOver ? " is-over" : ""}`}
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                >
                  <header className="delivery-column-head">
                    <b>{column.name}</b>
                    {column.subtitle ? <span>{column.subtitle}</span> : null}
                    <em className="manager-mono">
                      {column.doneCount}/{column.total}
                    </em>
								{column.items.some(isSelectable) ? (
									<Checkbox
										checked={column.items.filter(isSelectable).every((item) => selectedItemKeys.includes(item.itemKey))}
										indeterminate={column.items.filter(isSelectable).some((item) => selectedItemKeys.includes(item.itemKey)) && !column.items.filter(isSelectable).every((item) => selectedItemKeys.includes(item.itemKey))}
										onClick={(event) => event.stopPropagation()}
										onChange={(event) => {
											const keys = column.items.filter(isSelectable).map((item) => item.itemKey);
											onSelectionChange(event.target.checked ? Array.from(new Set([...selectedItemKeys, ...keys])) : selectedItemKeys.filter((key) => !keys.includes(key)));
										}}
									/>
								) : null}
                  </header>
                  <div className="delivery-column-rail">
                    <i style={{ width: `${column.progress}%` }} />
                  </div>
                  <div className="delivery-column-body">
                    {column.items.length === 0 ? (
                      <p className="delivery-column-empty">{t("delivery.emptyColumn")}</p>
                    ) : null}
                    {column.items.map((item, index) => (
                      <Draggable draggableId={item.itemKey} index={index} key={item.itemKey}>
                        {(dragProvided, dragSnapshot) => {
                          const isOwnerHighlighted = Boolean(highlightedOwner && item.ownerName === highlightedOwner);
                          return (
                          <article
                            className={`delivery-card${parallelItemKeys.has(item.itemKey) ? " is-parallel" : ""}${dragSnapshot.isDragging ? " is-dragging" : ""}${
                              dependencyDrag?.sourceItemKey === item.itemKey ? " is-dependency-source" : ""
                            }${dependencyDrag?.targetItemKey === item.itemKey ? " is-dependency-target" : ""}${isOwnerHighlighted ? " is-owner-highlighted" : ""}`}
                            data-delivery-item-key={item.itemKey}
                            style={{
                              ...dragProvided.draggableProps.style,
                              ["--card-accent" as string]: STATUS_COLORS[item.status as DeliveryStatus],
                            }}
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                            onClick={() => onOpen(item)}
                            onMouseEnter={() => setActiveItemKey(item.itemKey)}
                            onMouseLeave={() => setActiveItemKey(undefined)}
                          >
							{isOwnerHighlighted ? <span className="delivery-card-owner-highlight">{t("delivery.ownerHighlight.mark")}</span> : null}
                            {dependencyDrag?.targetItemKey === item.itemKey ? (
                              <span className="delivery-dependency-target-ports" aria-hidden="true">
                                {(["top", "right", "bottom", "left"] as const).map((side) => (
                                  <i className={dependencyDrag.targetSide === side ? "is-active" : ""} data-side={side} key={side} />
                                ))}
                              </span>
                            ) : null}
							{(["top", "right", "bottom", "left"] as const).map((side) => (
								<button
									type="button"
									className="delivery-dependency-handle"
									data-side={side}
									aria-label={t("delivery.dependencies.dragHandle")}
									title={t("delivery.dependencies.dragHandle")}
									key={side}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onMouseDown={(event) => event.stopPropagation()}
									onKeyDown={(event) => event.stopPropagation()}
									onPointerDown={(event) => startDependencyDrag(item.itemKey, side, event)}
									onTouchStart={(event) => event.stopPropagation()}
								>
									<LinkOutlined />
								</button>
							))}
                            <div className="delivery-card-top">
                              <span className="delivery-pill">{t(`delivery.status.${item.status}`)}</span>
                              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <em>{groupBy === "module" ? stageName(item.stageKey) : moduleName(item.moduleKey)}</em>
								{canExecute(item) ? (
                                  <Tooltip title={canExecute(item) ? t("delivery.execution.codex") : t("delivery.execution.unavailable")}>
                                    <Button
                                      type="text"
                                      size="small"
                                      shape="circle"
                                      icon={<PlayCircleOutlined />}
                                      loading={executingItemKey === item.itemKey}
                                      disabled={!canExecute(item)}
                                      aria-label={t("delivery.execution.codex")}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      onMouseDown={(event) => event.stopPropagation()}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onExecute(item);
                                      }}
                                    />
                                  </Tooltip>
                                ) : null}
                              </span>
                            </div>
							<b>{item.title}</b>
							{item.benefitTags.length ? <div className="delivery-card-benefit-tags">{item.benefitTags.map((tag) => <Tag color="gold" key={tag}>{tag}</Tag>)}</div> : null}
							<Tooltip title={t("delivery.session.viewTask")}>
												<Button
													className="delivery-card-session-button"
												type="text"
												size="small"
												icon={<MessageOutlined />}
												aria-label={t("delivery.session.viewTask")}
													onPointerDown={(event) => event.stopPropagation()}
													onClick={(event) => {
														event.stopPropagation();
														onOpenSession(item);
													}}
												>
													{t("delivery.session.viewTask")}
												</Button>
											</Tooltip>
									<div className="delivery-card-phases">
										<span className="is-current" title={t(`delivery.phase.${item.phase}`)}><i style={{ background: STATUS_COLORS[item.status] }} />{t(`delivery.phase.short.${item.phase}`)}</span>
									</div>
                            {item.description ? <p>{item.description}</p> : null}
                            <div className="delivery-card-rail">
                              <i style={{ width: `${item.progress}%` }} />
                            </div>
                            <div className="delivery-card-foot">
													{isSelectable(item) ? (
													<Checkbox checked={selectedItemKeys.includes(item.itemKey)} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectionChange(event.target.checked ? [...selectedItemKeys, item.itemKey] : selectedItemKeys.filter((key) => key !== item.itemKey))} />
												) : null}
                              <span>{t(`delivery.kind.${item.kind}`)}</span>
                              {item.dependsOnItemKeys.length > 0 ? (
                                <Tooltip
                                  title={`${t("delivery.field.dependsOnItemKeys")}: ${item.dependsOnItemKeys
                                    .map((itemKey) => itemNames.get(itemKey) ?? itemKey)
                                    .join("、")}`}
                                >
                                  <span className="delivery-card-dependency">
                                    <LinkOutlined /> {item.dependsOnItemKeys.length}
                                  </span>
                                </Tooltip>
                              ) : null}
                              <div
                                className="delivery-card-owner-select"
                                onPointerDown={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <Select
                                  allowClear
                                  showSearch
                                  size="small"
                                  optionFilterProp="label"
                                  value={item.ownerId || item.ownerName || undefined}
                                  placeholder={t("delivery.unassigned")}
                                  options={ownerOptions}
                                  loading={changingOwnerItemKey === item.itemKey}
                                  disabled={changingOwnerItemKey === item.itemKey}
                                  aria-label={t("delivery.field.ownerName")}
                                  onChange={(value) => onOwnerChange(item, value ?? "")}
                                />
                              </div>
                              <span className="manager-mono">{item.progress}%</span>
                            </div>
                          </article>
                          );
                        }}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                </section>
              )}
            </Droppable>
            );
          })}
        </div>
      </div>
    </DragDropContext>
  );
}
