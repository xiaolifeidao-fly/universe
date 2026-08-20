"use client";

import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Modal, Segmented, Space } from "antd";
import { useState, type ReactNode } from "react";
import { TranslationKey, useLocale } from "@/i18n/LocaleProvider";

interface TaskBoardStoryModalProps {
  open: boolean;
  onClose: () => void;
}

type SceneKey = "collab" | "focus" | "compute";

const SCENE_KEYS: SceneKey[] = ["collab", "focus", "compute"];

// 每个场景只描述一件事：现状为什么疼、任务面板换成了什么做法。
// 文案走 t()，示意图走 CSS 动画（globals.css 的 .board-story-* 一族）。
const SCENES: Record<SceneKey, { tag: TranslationKey; title: TranslationKey; pains: TranslationKey[]; fixes: TranslationKey[]; metric: TranslationKey }> = {
  collab: {
    tag: "story.s1.tag",
    title: "story.s1.title",
    pains: ["story.s1.pain1", "story.s1.pain2", "story.s1.pain3"],
    fixes: ["story.s1.fix1", "story.s1.fix2", "story.s1.fix3"],
    metric: "story.s1.metric",
  },
  focus: {
    tag: "story.s2.tag",
    title: "story.s2.title",
    pains: ["story.s2.pain1", "story.s2.pain2", "story.s2.pain3"],
    fixes: ["story.s2.fix1", "story.s2.fix2", "story.s2.fix3"],
    metric: "story.s2.metric",
  },
  compute: {
    tag: "story.s3.tag",
    title: "story.s3.title",
    pains: ["story.s3.pain1", "story.s3.pain2", "story.s3.pain3"],
    fixes: ["story.s3.fix1", "story.s3.fix2", "story.s3.fix3"],
    metric: "story.s3.metric",
  },
};

export function TaskBoardStoryModal({ open, onClose }: TaskBoardStoryModalProps) {
  const { t } = useLocale();
  const [scene, setScene] = useState<SceneKey>("collab");
  const index = SCENE_KEYS.indexOf(scene);
  const config = SCENES[scene];

  const step = (delta: number) => {
    const next = SCENE_KEYS[(index + delta + SCENE_KEYS.length) % SCENE_KEYS.length];
    setScene(next);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1120}
      destroyOnHidden
      className="board-story"
      title={(
        <div className="board-story__heading">
          <strong>{t("story.title")}</strong>
          <small>{t("story.subtitle")}</small>
        </div>
      )}
    >
      <div className="board-story__switcher">
        <Segmented
          value={scene}
          onChange={(value) => setScene(value as SceneKey)}
          options={SCENE_KEYS.map((key, order) => ({
            value: key,
            label: `${order + 1} · ${t(SCENES[key].tag)}`,
          }))}
        />
        <Space size={4}>
          <Button size="small" icon={<LeftOutlined />} onClick={() => step(-1)} aria-label={t("story.prev")} />
          <Button size="small" icon={<RightOutlined />} onClick={() => step(1)} aria-label={t("story.next")} />
        </Space>
      </div>

      <h3 className="board-story__scene-title">{t(config.title)}</h3>

      <div className="board-story__stage" key={scene}>
        {scene === "collab" ? <CollabScene /> : null}
        {scene === "focus" ? <FocusScene /> : null}
        {scene === "compute" ? <ComputeScene /> : null}
      </div>

      <div className="board-story__columns">
        <section className="board-story__card board-story__card--pain">
          <header>{t("story.painLabel")}</header>
          <ul>
            {config.pains.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </section>
        <section className="board-story__card board-story__card--fix">
          <header>{t("story.fixLabel")}</header>
          <ul>
            {config.fixes.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
          <div className="board-story__metric">{t(config.metric)}</div>
        </section>
      </div>

      <p className="board-story__footer">{t("story.footer")}</p>
    </Modal>
  );
}

function Node({ icon, label, tone }: { icon: string; label: string; tone?: "primary" | "muted" | "good" }) {
  return (
    <div className={`board-story-node board-story-node--${tone ?? "muted"}`}>
      <span className="board-story-node__icon">{icon}</span>
      <span className="board-story-node__label">{label}</span>
    </div>
  );
}

function Wire({ children, tone }: { children?: ReactNode; tone: "bad" | "good" }) {
  return <div className={`board-story-wire board-story-wire--${tone}`}>{children}</div>;
}

/** 场景一：口述传递会掉信息，文档 + AI 传递不会。 */
function CollabScene() {
  const { t } = useLocale();
  return (
    <div className="board-story-collab">
      <div className="board-story-lane board-story-lane--bad">
        <span className="board-story-lane__tag">{t("story.s1.laneBad")}</span>
        <div className="board-story-lane__flow">
          <Node icon="🙋" label={t("story.s1.owner")} />
          <Wire tone="bad">
            <span className="board-story-packet board-story-packet--decay">
              <i className="board-story-shard board-story-shard--1" />
              <i className="board-story-shard board-story-shard--2" />
              <i className="board-story-shard board-story-shard--3" />
            </span>
          </Wire>
          <Node icon="🧑‍💻" label={t("story.s1.peer")} />
        </div>
        <span className="board-story-lane__score board-story-lane__score--bad">{t("story.s1.scoreBad")}</span>
      </div>

      <div className="board-story-lane board-story-lane--good">
        <span className="board-story-lane__tag">{t("story.s1.laneGood")}</span>
        <div className="board-story-lane__flow">
          <Node icon="🙋" label={t("story.s1.owner")} />
          <Wire tone="good">
            <span className="board-story-packet board-story-packet--intact" />
          </Wire>
          <Node icon="🤖" label={t("story.s1.groom")} tone="primary" />
          <Wire tone="good">
            <span className="board-story-packet board-story-packet--intact board-story-packet--delay" />
          </Wire>
          <Node icon="📄" label={t("story.s1.doc")} tone="good" />
          <Wire tone="good">
            <span className="board-story-packet board-story-packet--intact board-story-packet--delay2" />
          </Wire>
          <Node icon="🧑‍💻" label={t("story.s1.peer")} />
        </div>
        <span className="board-story-lane__score board-story-lane__score--good">{t("story.s1.scoreGood")}</span>
      </div>
    </div>
  );
}

/** 场景二：把「问一句等一会」的碎片时间换成一次性拆解 + 批量执行。 */
function FocusScene() {
  const { t } = useLocale();
  return (
    <div className="board-story-focus">
      <div className="board-story-timeline">
        <span className="board-story-timeline__tag">{t("story.s2.before")}</span>
        <div className="board-story-timeline__track">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="board-story-frag">
              <i className="board-story-frag__ask" style={{ animationDelay: `${i * 0.35}s` }} />
              <i className="board-story-frag__wait" style={{ animationDelay: `${i * 0.35}s` }} />
            </span>
          ))}
        </div>
        <span className="board-story-timeline__note board-story-timeline__note--bad">{t("story.s2.beforeNote")}</span>
      </div>

      <div className="board-story-timeline">
        <span className="board-story-timeline__tag">{t("story.s2.after")}</span>
        <div className="board-story-timeline__track board-story-timeline__track--after">
          <span className="board-story-block board-story-block--plan">{t("story.s2.plan")}</span>
          <span className="board-story-block board-story-block--exec">
            <span className="board-story-exec__label">{t("story.s2.exec")}</span>
            {Array.from({ length: 3 }).map((_, i) => (
              <i key={i} className="board-story-exec__bar" style={{ animationDelay: `${i * 0.6}s` }} />
            ))}
          </span>
          <span className="board-story-block board-story-block--review">{t("story.s2.review")}</span>
        </div>
        <div className="board-story-freetime">
          <span>{t("story.s2.freeTime")}</span>
        </div>
      </div>
    </div>
  );
}

/** 场景三：一份梳理好的任务，派给多台本机环境并发跑。 */
function ComputeScene() {
  const { t } = useLocale();
  const members = [t("story.s3.member1"), t("story.s3.member2"), t("story.s3.member3"), t("story.s3.member4")];
  return (
    <div className="board-story-compute">
      <div className="board-story-hub">
        <span className="board-story-hub__icon">🗂️</span>
        <strong>{t("story.s3.board")}</strong>
        <small>{t("story.s3.boardNote")}</small>
      </div>
      <div className="board-story-fanout">
        {members.map((name, i) => (
          <div className="board-story-member" key={name}>
            <span className="board-story-member__wire">
              <i className="board-story-member__task" style={{ animationDelay: `${i * 0.5}s` }} />
            </span>
            <div className="board-story-member__card">
              <span className="board-story-member__name">💻 {name}</span>
              <span className="board-story-member__meter">
                <i style={{ animationDelay: `${i * 0.5}s` }} />
              </span>
              <small>{t("story.s3.localToken")}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="board-story-throughput">
        <span className="board-story-throughput__row">
          <em>{t("story.s3.serial")}</em>
          <i className="board-story-throughput__bar board-story-throughput__bar--serial" />
        </span>
        <span className="board-story-throughput__row">
          <em>{t("story.s3.parallel")}</em>
          <i className="board-story-throughput__bar board-story-throughput__bar--parallel" />
        </span>
      </div>
    </div>
  );
}
