"use client";

import { getData } from "@/utils/axios";

/**
 * 邀请返现。奖励由平台额外发放：好友自己的收益不变，邀请人另拿好友「结算入账的积分」的 rate。
 * 只返一层；同一台设备上跑出来的收益不返（防拿小号邀请自己）。
 */
export class ReferralOverview {
  /** 8 位大写字母数字，第一次打开时服务端生成。 */
  code = "";

  /** 完整邀请链接（注册页地址?invite=邀请码）。服务端没配注册页地址时是空串。 */
  link = "";

  /** 0.1 表示 10%。 */
  rate = 0;

  /** 返现期限（天），好友注册后算起；0 = 长期。 */
  days = 0;

  /** rate > 0。平台把比例调成 0 就是暂停。 */
  enabled = false;

  invitees = 0;

  /** 累计邀请奖励，已扣掉申诉追回的，积分。 */
  rewardTotal = 0;

  /** 近 7 天。 */
  rewardWeek = 0;

  /** 还在争议期、暂不可提现的那部分。 */
  rewardPending = 0;
}

export class ReferralInvitee {
  /** 服务端打过码的用户名，如 al***e。 */
  name = "";

  joinedAt = "";

  /** 这位好友给你带来的奖励。 */
  rewardTotal = 0;

  lastRewardAt?: string;

  /** days > 0 时返现截止的时间。 */
  expiresAt?: string;
}

export class ReferralInviteePage {
  total = 0;

  /** 嵌套数组不经过 class-transformer，里面是普通对象，可选字段按可能缺失读。 */
  items: ReferralInvitee[] = [];
}

export async function fetchReferral() {
  return getData(ReferralOverview, "/galaxy/provider/referral");
}

export async function fetchInvitees(params: { offset: number; limit: number }) {
  return getData(ReferralInviteePage, "/galaxy/provider/referral/invitees", params);
}
