"use client";

import type { HookAPI } from "antd/es/modal/useModal";
import { message } from "antd";

import { setContributionStatus, type ContributionStatusResult, type ContributionView } from "./api/provider.api";

/**
 * 关闭一条共享。「今天」页的开关和共享设置页的开关共用这一份 ——
 * 两处对同一件事给出不同说法，是最容易让主人以为「关了没生效」的来源。
 *
 * 关闭在服务端有三种结局，界面必须分开讲：
 *
 *   手上没活    静默关掉，不打扰。
 *   有活在跑    已经停止接新单，跑完自动关闭。这里**只提示一次**并给出「立即关闭」，
 *               绝不自动重试 —— 主人点一次就该结束，剩下的交给服务端。
 *   立即关闭    掐断在跑的请求，扣信誉分。必须先确认，而且把代价说清楚。
 */

/** 强制关闭要扣的信誉分。和服务端的 ForceCloseReputationPenalty 是同一个数，只用于确认框里的说明。 */
const FORCE_PENALTY = 0.05;

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 关闭时落到哪个状态。「今天」页是暂停（今天不接了），共享设置页是停掉这条能力。 */
export type OffStatus = "paused" | "disabled";

/**
 * 开关若干条贡献，并把结果讲给主人听。
 *
 * rows 允许多条是为了总开关：主人按它是想「现在别接单了」，那就该一次说完
 * ——「3 条里有 1 条还在跑」，而不是弹三个一模一样的提示。
 */
export async function switchContributions(options: {
  rows: ContributionView[];
  on: boolean;
  offStatus: OffStatus;
  t: Translate;
  /** 改完之后重新拉数据。 */
  reload: () => Promise<void>;
}): Promise<void> {
  const { rows, on, offStatus, t, reload } = options;
  if (rows.length === 0) return;

  const results = await Promise.all(
    rows.map((row) => setContributionStatus(row.nodeId, row.cid, on ? "active" : offStatus)),
  );
  await reload();
  if (on) return;

  // 排队的那些：服务端已经停止接新单了，这里只负责说清楚还剩多少。
  //
  // **不在这里追着弹确认框。** 主人刚点完关闭，紧接着弹一个「要不要现在就关」，
  // 等于把他刚摆脱的那一下又还回去。想不等的人会去点那条能力上的「立即关闭」，
  // 而绝大多数人只是想关掉走人 —— 那件事已经办完了。
  const pending = results.filter((item) => item.pending);
  if (pending.length === 0) return;
  const inflight = pending.reduce((sum, item) => sum + item.inflight, 0);
  message.info({ content: t("close.pending", { value: inflight }), duration: 6 });
}

/**
 * 「立即关闭」的确认框。
 *
 * 单独导出是因为它有两个入口：刚点完关闭时顺手问一次，以及之后在那条「正在收尾」
 * 的能力上随时点。两个入口问的是同一件事，话术不能有第二份。
 */
export async function confirmForceClose(options: {
  rows: ContributionView[];
  inflight: number;
  offStatus: OffStatus;
  t: Translate;
  modal: HookAPI;
  reload: () => Promise<void>;
}): Promise<void> {
  const { rows, inflight, offStatus, t, modal, reload } = options;
  if (rows.length === 0) return;
  modal.confirm({
    title: t("close.forceTitle"),
    content: t("close.forceConfirm", { value: inflight, penalty: FORCE_PENALTY }),
    okText: t("close.forceOk"),
    okButtonProps: { danger: true },
    cancelText: t("close.forceCancel"),
    onOk: async () => {
      try {
        const results = await Promise.all(
          rows.map((row) => setContributionStatus(row.nodeId, row.cid, offStatus, true)),
        );
        await reload();
        reportForced(results, t);
      } catch (error) {
        message.error((error as Error).message || t("common.actionFailed"));
      }
    },
  });
}

/**
 * 强制关闭之后的回执。
 *
 * 扣没扣分要如实说：扣了不说，主人下次看到派单变少会以为是平台在暗中降权；
 * 而「手上恰好没活所以没扣」也要说，否则他会以为每次强制都要付代价，于是不敢用。
 */
function reportForced(results: ContributionStatusResult[], t: Translate): void {
  const aborted = results.reduce((sum, item) => sum + item.aborted, 0);
  const penalty = results.reduce((sum, item) => sum + item.reputationDelta, 0);
  if (aborted === 0) {
    message.success(t("close.forcedClean"));
    return;
  }
  message.warning({
    content: t("close.forcedDone", { value: aborted, penalty: Math.abs(penalty).toFixed(2) }),
    duration: 6,
  });
}

/** 这条贡献是不是正在收尾：主人点过关闭，但手上的活还没跑完。 */
export function isClosing(row: ContributionView): boolean {
  return Boolean(row.pendingStatus);
}
