"use client";

import { EditOutlined, MessageOutlined, PlusCircleOutlined } from "@ant-design/icons";
import { Drawer, Empty, Spin, Tag, Timeline, message } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchRequirementTimeline,
  type DeliveryRequirementRecord,
  type DeliveryRequirementTimelineEventRecord,
} from "@/api/delivery.api";

interface DeliveryRequirementTimelineDrawerProps {
  open: boolean;
  programId: number;
  requirement: DeliveryRequirementRecord | null;
  onClose: () => void;
}

export function DeliveryRequirementTimelineDrawer({
  open,
  programId,
  requirement,
  onClose,
}: DeliveryRequirementTimelineDrawerProps) {
  const { t } = useLocale();
  const [events, setEvents] = useState<DeliveryRequirementTimelineEventRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!open || !programId || !requirement) return;
    setLoading(true);
    try {
      const page = await fetchRequirementTimeline(programId, requirement.requirementKey);
      setEvents(page.data);
    } catch (error) {
      setEvents([]);
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, programId, requirement]);

  useEffect(() => {
    if (open) void load();
    else setEvents([]);
  }, [load, open]);

  const eventText = (event: DeliveryRequirementTimelineEventRecord) => {
    if (event.kind === "comment") return event.comment;
    if (event.kind === "create") {
      return event.source === "requirement"
        ? t("delivery.requirement.timelineCreated")
        : t("delivery.event.created");
    }
    if (event.kind === "delete") {
      return event.source === "requirement"
        ? t("delivery.requirement.timelineDeleted")
        : t("delivery.event.deleted");
    }
    const field = t(`delivery.field.${event.field}`);
    const from = event.fromValue || t("delivery.empty");
    const to = event.toValue || t("delivery.empty");
    return `${field}: ${from} → ${to}`;
  };

  const eventIcon = (event: DeliveryRequirementTimelineEventRecord) => {
    if (event.kind === "create") return <PlusCircleOutlined />;
    if (event.kind === "comment") return <MessageOutlined />;
    return <EditOutlined />;
  };

  return (
    <Drawer
      className="delivery-requirement-timeline-drawer"
      width="min(680px, 100vw)"
      open={open}
      onClose={onClose}
      title={requirement ? (
        <div>
          <span>{t("delivery.requirement.timeline")}</span>
          <small className="delivery-drawer-title-meta">{requirement.name || requirement.requirementKey}</small>
        </div>
      ) : ""}
    >
      <Spin spinning={loading}>
        {!events.length && !loading ? <Empty description={t("delivery.requirement.timelineEmpty")} /> : (
          <Timeline
            className="delivery-requirement-timeline"
            items={events.map((event, index) => ({
              key: `${event.source}-${event.itemKey}-${event.createdAt}-${index}`,
              color: event.source === "requirement" ? "green" : "blue",
              dot: eventIcon(event),
              children: (
                <article className="delivery-event delivery-requirement-timeline__event">
                  <div className="delivery-requirement-timeline__event-head">
                    <Tag color={event.source === "requirement" ? "green" : "blue"}>
                      {event.source === "requirement" ? t("delivery.requirement.timelineRequirement") : t("delivery.requirement.timelineTask")}
                    </Tag>
                    {event.source === "item" && event.itemKey ? <code className="manager-mono">{event.itemKey}</code> : null}
                  </div>
                  <b>{eventText(event)}</b>
                  <small className="manager-mono">{dayjs(event.createdAt).format("MM-DD HH:mm")} · {event.actorName || event.actorId}</small>
                </article>
              ),
            }))}
          />
        )}
      </Spin>
    </Drawer>
  );
}
