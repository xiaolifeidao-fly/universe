"use client";

/**
 * 共享设置 —— 提供者的**唯一**配置入口。
 *
 * 开关、额度、座位、接哪些模型分组、挂机时段都在这里改，改完下一次心跳（≤15s）
 * 那台机器就换过来了。主人不需要回到那台机器上做任何事。
 *
 * 范围只有一处可改：**加入哪些分组**。分组属于某一个模型，勾上「Claude Sonnet 5 ·
 * 标准」就是提供这个模型这一档的能力。2026-09-22 之前这里还并排摆着一对模型通配
 * 名单（允许 / 拒绝），已经撤掉 —— 两道闸各拦一半的时候，主人勾了分组却接不到单，
 * 界面上看不出是哪一道拦的。
 *
 * 按机器分开看：左边挑一台，右边只摆这一台的能力和设置，默认选中这台电脑。
 * 工作室名下除了这台电脑，还可能有机房里用接入密钥注册的一排服务器 —— 每台都有
 * 一条同名的 relay_claude，平铺在一张表里分不清改的是哪一台。
 * 散户只有这台电脑：名下就算还挂着别的机器也不列（见 visibleNodes）。
 *
 * 仍然不能在这里**凭空造**一条贡献：能力是节点探测出来上报的，
 * 「这台机器上有没有 Claude」只有那台机器知道。控制台管的是「要不要、给多少」。
 *
 * 两个状态要分开看，处置方式完全不同：
 *   status=disabled  你自己关掉了        → 打开就行
 *   available=false  那台机器干不了这件事 → 得去那台机器上修（多半是登录态过期）
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HourBar } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
  IconGpu,
  IconMonitor,
  IconPlus,
  IconSparkle,
} from "@/components/ui/icons";
import {
  Btn,
  Card,
  CardHead,
  EmptyState,
  Field,
  LinkBtn,
  LiveDot,
  Loading,
  Meter,
  Note,
  Pill,
  Seg,
  Switch,
} from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { isStudio } from "@/utils/auth";
import { formatPoints, formatRelative, unitLabel } from "@/utils/format";
import { isDesktop } from "@/utils/product";
import { hoursToSchedule, scheduleToHours } from "@/utils/schedule";
import { confirmForceClose, isClosing, switchContributions } from "../../contributionClose";
import {
  fetchModelOptions,
  fetchNodes,
  isNodeOnline,
  nodeDisplayName,
  orderMachines,
  saveContributionLimits,
  visibleContributions,
  visibleNodes,
  type ContributionView,
  type ModelGroupPrice,
  type ModelOptionGroup,
  type UpstreamFloor,
  type NodeView,
  type QuotaGrantInput,
} from "../../api/provider.api";
import { pingBridge, startUpstreamLogin } from "../../api/bridge.api";
import { useCurrentAccount } from "../../useAccount";
import { MachineRail } from "./MachineRail";

/**
 * llm.chat 的常用维度。别的 kind 自己加行。
 *
 * 合计排第一，「加一条额度」默认给的也是它：主人心里的那条线是「这台机器一天最多跑
 * 多少 token」，而不是分头给输入、输出、缓存读、缓存写各设一个。分开设的坏处是
 * 任何一条先触顶就把整台机器停了，剩下几条还空着大半 —— 尤其是 Claude 那边，
 * 缓存读经常是新增输入的几十倍，两条上限根本没法按同一个量级去填。
 *
 * 四个分项仍然留着：想单独卡住某一项（比如只想限缓存写入）的时候还用得上。
 */
const COMMON_UNITS = ["llm.total_tokens", "llm.output_tokens", "llm.input_tokens", "llm.calls", "time.seconds"];

/**
 * 余量下限可以盯哪些窗口。
 *
 * 空串是「任一窗口」，排第一也是默认那条：上游报几个窗口、各叫什么由上游说了算，
 * 主人多半只想说一句「快用完了就别接了」，不想先去认识 5h 和 7d 这两个词。
 * 5h / 7d 是 Claude 与 Codex 现在都报的那两个；机器报出别的窗口时会自动补进来
 * （见 floorWindows），所以这里写死两个不会挡住新窗口。
 */
const FLOOR_WINDOWS = ["", "5h", "7d"];

/** 和「今天」同一个节奏：心跳 15 秒一次，前端刷得比数据还勤没有意义。 */
const REFRESH_MS = 20_000;

/**
 * 分组表的列宽。表头和每一行共用同一份 —— 各写一份迟早错开一列。
 *
 * 列的含义与「模型」那一页的分组表（ModelDetail）一一对应：那一页只读，
 * 这一页点一下就是加入或退出。两页说同一件事，摆法不一样只会让人以为是两件事。
 */
const GROUP_COLUMNS = "minmax(0, 1fr) 76px 84px 84px 84px";

/** 0 不写成「0」：那一档没有价，写 0 会被读成免费。和「模型」那一页同一条规矩。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

/**
 * 「接哪些分组」那一块里的一行：一个模型，连同它在卖的分组。
 *
 * available 是**节点报的事实**（这台机器的上游此刻有没有它），只作标注 ——
 * 清单以平台目录为准，见 modelChoices 的注释。
 */
interface ModelChoice {
  modelId: string;
  modelName: string;
  available: boolean;
  groups: ModelGroupPrice[];
}

interface Draft {
  /**
   * 加入了哪些模型分组。**空数组 = 不限**，什么分组的单都接（存量车道就是这样）。
   *
   * 这一条就是这台机器的全部范围设置：分组属于某一个模型，加入了哪些分组，
   * 就提供那些模型的那几档能力 —— 同一个模型的「标准」和「深度」是两份结算价、
   * 两种上游消耗，可以只接前者。
   */
  groups: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  floors: UpstreamFloor[];
  hours: boolean[];
}

function toDraft(row: ContributionView): Draft {
  return {
    groups: [...(row.groups ?? [])],
    seats: row.seats || 3,
    seatConcurrency: row.seatConcurrency || 2,
    quota: (row.quota ?? []).map((item) => ({ unit: item.unit, limit: item.limit, window: item.window || "day" })),
    // 服务端保证至少一条，这里的兜底只为「老服务端还没有这个字段」那一阵子：
    // 空数组会让整段界面消失，而主人会以为这台机器不受保护。
    floors: (row.upstreamFloors ?? []).length > 0
      ? (row.upstreamFloors ?? []).map((item) => ({ window: item.window || "", percent: item.percent || 0 }))
      : [{ window: "", percent: 0 }],
    hours: scheduleToHours(row.schedule),
  };
}

/** 改了几处。摆在保存条上，因为「有没有没保存的东西」比「保存按钮亮不亮」更该被看见。 */
function countChanges(draft: Draft, row: ContributionView): number {
  const base = toDraft(row);
  let changes = 0;
  if (draft.groups.join() !== base.groups.join()) changes += 1;
  if (draft.seats !== base.seats) changes += 1;
  if (draft.seatConcurrency !== base.seatConcurrency) changes += 1;
  if (JSON.stringify(draft.quota) !== JSON.stringify(base.quota)) changes += 1;
  if (JSON.stringify(draft.floors) !== JSON.stringify(base.floors)) changes += 1;
  if (draft.hours.join() !== base.hours.join()) changes += 1;
  return changes;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 列表里补上的「这台电脑」那一项的选中键。节点 id 都是 n_ 开头，撞不上。 */
const THIS_COMPUTER = "this-computer";

/** 这台电脑为什么不在名下机器里：还没配过，或者配过但已解绑（本机还拿着平台不认的旧令牌）。 */
type LocalGap = "unpaired" | "detached";

export function ShareSettings() {
  const { t } = useLocale();
  const router = useRouter();
  // 散户的左栏只摆这台电脑：机房那一排服务器是工作室才有的东西。
  const studio = isStudio(useCurrentAccount());
  // 用 hook 版而不是 Modal.confirm：静态方法拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色。
  const [modal, modalHolder] = Modal.useModal();
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // 本机 bridge 报的自己：配没配过、配出来的是哪个节点。决定默认选中哪台、
  // 「去授权」给不给（浏览器够不到别的机器的 bridge），以及要不要在列表顶上补一项「这台电脑」。
  // 纯浏览器里是 null：浏览器不是任何一台机器。
  const [local, setLocal] = useState<{ paired: boolean; nodeId: string } | null>(null);
  // 平台在卖的模型，按厂商分好组（服务端给）。两个模型框的候选项就出自这里。
  const [modelGroups, setModelGroups] = useState<ModelOptionGroup[]>([]);
  // 主人点过的机器与能力。空串是没点过：机器落在这台电脑上，能力落在第一条。
  const [pickedNode, setPickedNode] = useState("");
  const [pickedCid, setPickedCid] = useState("");
  // 草稿记着自己是哪一条贡献的。轮询换掉 nodes 时不能跟着重置，
  // 否则 20 秒一刷，正在填的数字就被冲掉了。
  const [draft, setDraft] = useState<{ key: string; value: Draft } | null>(null);

  const reload = useCallback(async () => {
    setNodes(await fetchNodes());
  }, []);

  useEffect(() => {
    let alive = true;
    // 桌面里 ping 失败（bridge 进程没起来）也算「这台电脑还没接进来」：入口照样给，
    // 点进配对页，第一步会把 bridge 的真实错误摆出来。
    const self = isDesktop()
      ? pingBridge().then((ping) => ({ paired: Boolean(ping?.paired && ping.nodeId), nodeId: ping?.nodeId ?? "" }))
      : Promise.resolve(null);
    void self.then((value) => {
      if (alive) setLocal(value);
    });
    // 第一屏等本机 bridge 报出自己是哪台再画：分两步到的话，默认选中会先落在
    // 别的机器上、再跳回这台电脑。等不过 1.5 秒就先画，IPC 卡住不能把整页挡在加载圈上。
    void Promise.all([fetchNodes(), Promise.race([self, delay(1500)])])
      .then(([list]) => {
        if (alive) setNodes(list);
      })
      .catch((error) => message.error((error as Error).message || t("common.loadFailed")))
      .finally(() => {
        if (alive) setLoading(false);
      });
    // 模型候选只取一次，不进那个 20 秒的轮询：它是平台的模型目录，
    // 不会在主人填规则的这几分钟里变。失败也不弹 —— 没有候选项这两个框
    // 照样能手输入（它们收的本来就是通配模式），为它挡住整页得不偿失。
    void fetchModelOptions()
      .then((groups) => {
        if (alive) setModelGroups(groups);
      })
      .catch(() => undefined);
    // 别的机器上下线、登录态过期都得看得见。刷新失败不弹：
    // 断网时每 20 秒冒一条报错，比数据旧 20 秒更扰人。
    const timer = setInterval(() => void reload().catch(() => undefined), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reload, t]);

  const localNodeId = local?.nodeId ?? "";
  const machines = useMemo(() => orderMachines(visibleNodes(nodes, studio, local), localNodeId), [nodes, studio, local, localNodeId]);
  // 这台电脑不在名下机器里（还没配过，或者在控制台解绑过）时，列表顶上补一项「这台电脑」。
  //
  // 不补的话它在控制台里连个入口都没有：解绑过的电脑本机还拿着旧令牌，自认为配着，
  // 账户页不会提示去配对；名下只要还有别的机器，各处的「去配对」空状态也都不出现。
  const localGap: LocalGap | null = local && !nodes.some((node) => node.nodeId === local.nodeId)
    ? local.paired ? "detached" : "unpaired"
    : null;
  // 当前选中的是哪一项。点过的那台没了（被解绑、重新配对换了 nodeId）就回到默认：这台电脑 ——
  // 它在名下就是它自己（orderMachines 钉在第一个），不在名下就是补的那一项。
  const selectedKey =
    pickedNode === THIS_COMPUTER && localGap
      ? THIS_COMPUTER
      : machines.some((node) => node.nodeId === pickedNode)
        ? pickedNode
        : localGap
          ? THIS_COMPUTER
          : (machines[0]?.nodeId ?? "");
  const machine = machines.find((node) => node.nodeId === selectedKey) ?? null;
  const rows = useMemo(() => visibleContributions(machine?.contributions), [machine]);
  const current = rows.find((row) => row.cid === pickedCid) ?? rows[0] ?? null;
  const currentKey = current ? `${current.nodeId}:${current.cid}` : "";
  const form = useMemo(
    () => (current ? (draft?.key === currentKey ? draft.value : toDraft(current)) : null),
    [current, currentKey, draft],
  );
  const changes = current && form ? countChanges(form, current) : 0;
  /**
   * 这条车道能接哪些模型、每个模型在卖哪几档。
   *
   * 厂商由车道自己定（relay_claude 就是 Claude），所以这里不让主人再选一次厂商：
   * 按 category 取自己那一族就行 —— 给一条 Claude 车道列一排 gpt，选中了也是白选。
   *
   * 两份数据合在一起，但分工不同：
   *   目录（服务端按厂商分组）  平台在卖什么 —— 清单以它为准
   *   节点报的 availableModels  这台机器此刻真有什么 —— 只做标注
   *
   * 反过来拿节点那份当清单是行不通的：它是探测来的，上游抽一次风就空半天
   * （见 pool/models.rs 的降级），主人会以为自己突然没有模型可选了。而目录是
   * 平台的声明，不会抖。
   *
   * 没有分组的模型不列：一个分组都没上架的模型，谁也接不到它的单，
   * 摆出来只会给人一个点不动的空壳。
   */
  const modelChoices = useMemo<ModelChoice[]>(() => {
    if (!current) return [];
    const available = current.availableModels ?? [];
    const catalog = modelGroups.find((group) => group.category === current.category)?.models ?? [];
    return catalog
      .filter((model) => (model.groups ?? []).length > 0)
      .map((model) => ({
        modelId: model.modelId,
        modelName: model.displayName || model.modelId,
        available: available.includes(model.modelId),
        groups: model.groups ?? [],
      }));
  }, [current, modelGroups]);
  /**
   * 这台机器探到了、而平台没在卖的模型。
   *
   * 摆一句出来是因为不摆的话这件事无处可查：主人看着本机的 claude 里明明有这个模型，
   * 清单里却没有，会以为是控制台漏了。它共享不出去 —— 平台没上架就没有价、没有分组，
   * 也就没有人买得到。
   */
  const offCatalog = useMemo(() => {
    if (!current) return [] as string[];
    const catalog = modelGroups.find((group) => group.category === current.category)?.models ?? [];
    const listed = new Set(catalog.map((model) => model.modelId));
    return (current.availableModels ?? []).filter((model) => !listed.has(model));
  }, [current, modelGroups]);
  /**
   * 这台机器此刻各窗口还剩百分之多少（节点五分钟一轮探来的）。
   *
   * 只用来在每条下限旁边写一句「当前剩 83%」—— **判定不在这里**：真正决定
   * 接不接单的是服务端（current.upstreamBlock），两边各算一套迟早对不上。
   * 同一个窗口有好几个桶时取最低的那个，和服务端同一个口径。
   */
  const observedLeft = useMemo(() => {
    const out: Record<string, number> = {};
    for (const bucket of current?.upstreamUsage?.buckets ?? []) {
      const left =
        bucket.usedPercent !== undefined
          ? 100 - bucket.usedPercent
          : bucket.remaining !== undefined && bucket.limit !== undefined && bucket.limit > 0
            ? (bucket.remaining / bucket.limit) * 100
            : undefined;
      if (left === undefined) continue;
      const window = (bucket.window || "").toLowerCase();
      out[window] = out[window] === undefined ? left : Math.min(out[window], left);
    }
    return out;
  }, [current]);
  // 可选窗口 = 写死那几个 + 这台机器真报出来的 + 已经填过的。
  // 上游哪天多出一个窗口，主人当天就能给它设线，不用等我们改前端。
  const floorWindows = useMemo(
    () => Array.from(new Set([...FLOOR_WINDOWS, ...Object.keys(observedLeft), ...(form?.floors ?? []).map((item) => item.window)])),
    [observedLeft, form],
  );
  // 一个窗口只能有一条线：两条盯同一个窗口时，宽的那条永远不生效，
  // 而主人看着界面上明明写着的数字，不会想到它是死的。服务端也会拦，这里先不让选。
  const usedWindows = useMemo(() => new Set((form?.floors ?? []).map((item) => item.window)), [form]);
  const freeWindow = floorWindows.find((window) => !usedWindows.has(window));
  const isLocal = Boolean(machine && localNodeId && machine.nodeId === localNodeId);

  const edit = (value: Draft) => setDraft({ key: currentKey, value });

  // 一个计量单位只能配一条上限（唯一键是 cid + unit）。让界面自己不产生重复，
  // 比让主人填完点保存再看一句数据库报错要好。
  const usedUnits = useMemo(() => new Set((form?.quota ?? []).map((item) => item.unit)), [form]);
  const freeUnit = COMMON_UNITS.find((unit) => !usedUnits.has(unit));

  /**
   * 切机器、切能力之前，有没保存的修改就先问一句。
   *
   * 草稿只跟着一条贡献走，切走就丢 —— 留着更糟：回来时分不清哪些数字是改过没存的。
   * 以前只能在两三条能力间切，悄悄丢也就算了；现在左边一排机器点起来很顺手，
   * 悄悄丢就成了常事。
   */
  const leave = (next: () => void) => {
    const go = () => {
      setDraft(null);
      next();
    };
    if (changes === 0 || !current || !machine) {
      go();
      return;
    }
    void modal.confirm({
      title: t("share.switchTitle"),
      content: t("share.switchConfirm", { name: nodeDisplayName(machine), cid: current.cid, value: changes }),
      okText: t("share.switchOk"),
      okButtonProps: { danger: true },
      cancelText: t("share.switchCancel"),
      onOk: go,
    });
  };

  const selectMachine = (key: string) => {
    if (key === selectedKey) return;
    leave(() => {
      setPickedNode(key);
      setPickedCid("");
    });
  };

  const selectContribution = (cid: string) => {
    if (cid === current?.cid) return;
    leave(() => setPickedCid(cid));
  };

  const toggle = async (row: ContributionView, on: boolean) => {
    setBusy(true);
    try {
      await switchContributions({ rows: [row], on, offStatus: "disabled", t, reload });
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** 「正在收尾」时的「立即关闭」：掐断在跑的请求，扣信誉分，自己会先确认。 */
  const forceClose = (row: ContributionView) =>
    void confirmForceClose({ rows: [row], inflight: row.inflight, offStatus: "disabled", t, modal, reload });

  const authorize = async (row: ContributionView) => {
    setBusy(true);
    try {
      const result = await startUpstreamLogin(row.cid);
      if (result.alreadyAuthorized) message.info(t("share.authAlready"));
      else if (result.launched) message.success(t("share.authLaunched"));
      else message.warning(t("share.authManual", { command: result.command }));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!current || !form) return;
    setBusy(true);
    try {
      await saveContributionLimits({
        nodeId: current.nodeId,
        cid: current.cid,
        groups: form.groups,
        seats: form.seats,
        seatConcurrency: form.seatConcurrency,
        quota: form.quota.filter((item) => item.unit && item.limit > 0),
        upstreamFloors: form.floors,
        schedule: hoursToSchedule(form.hours, Intl.DateTimeFormat().resolvedOptions().timeZone),
      });
      message.success(t("common.saved"));
      await reload();
      // 服务端会规整（limit 为 0 的额度行不存），草稿换成它存下来的样子，
      // 不然保存成功了底下还挂着「有 1 处未保存」。
      setDraft(null);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  // 名下一台都没有、又不在 Nova 桌面里（没有「这台电脑」可补）才是真的空。
  if (!machine && !localGap) {
    return (
      <>
        <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
        <div className="gx-body">
          <Card>
            <EmptyState
              title={t("share.emptyTitle")}
              hint={t("share.emptyHint")}
              action={
                <Btn tone="accent" onClick={() => router.push("/provider/pair")}>
                  {t("today.emptyAction")}
                </Btn>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const online = machine ? isNodeOnline(machine) : false;
  const endpointText =
    machine?.endpointStatus === "ok"
      ? t("account.endpointOk")
      : machine?.endpointStatus === "unreachable"
        ? [t("account.endpointDown"), machine.endpointError].filter(Boolean).join(" — ")
        : t("account.endpointPending");

  const detail = !machine ? (
    <ThisComputerCard gap={localGap ?? "unpaired"} nodeId={localNodeId} />
  ) : (
    <>
      <Card className="gx-rise gx-rise--1">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px 12px" }}>
          <span
            style={{
              width: 36,
              height: 36,
              flex: "0 0 auto",
              borderRadius: 10,
              display: "grid",
              placeItems: "center",
              background: "var(--gx-muted)",
              color: "var(--gx-soft)",
            }}
          >
            <IconMonitor size={19} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {nodeDisplayName(machine)}
              </span>
              {isLocal ? <Pill>{t("account.thisComputer")}</Pill> : null}
            </span>
            <span
              className="gx-mono"
              style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={machine.nodeId}
            >
              ai-bridge {machine.bridgeVersion || "-"} ·{" "}
              {machine.lastBeatAt ? t("share.machineBeat", { value: formatRelative(machine.lastBeatAt) }) : t("share.machineNeverSeen")} ·{" "}
              {machine.nodeId}
            </span>
            {machine.accessMode === "export" ? (
              <span
                className="gx-mono"
                style={{
                  display: "block",
                  fontSize: 11,
                  marginTop: 2,
                  color: machine.endpointStatus === "unreachable" ? "var(--gx-danger)" : "var(--gx-faint)",
                  overflowWrap: "anywhere",
                }}
              >
                {machine.endpointUrl || "-"} · {endpointText}
              </span>
            ) : null}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
            <Pill>{machine.accessMode === "export" ? t("account.accessExport") : t("account.accessPoll")}</Pill>
            <Pill tone={machine.banned ? "err" : online ? "ok" : "default"}>
              {machine.banned ? null : <LiveDot on={online} />}
              {machine.banned ? t("share.machineBanned") : online ? t("share.machineOnline") : t("share.machineOffline")}
            </Pill>
          </span>
        </div>

        {machine.banned || (!online && rows.length > 0) ? (
          <div style={{ padding: "0 18px 6px" }}>
            {/* 离线不妨碍改：设置存在平台上，平台是额度与时段的权威，那台机器连回来就照新的来。
                一条能力都没报过的机器没什么可改，这句就不说了，下面的空状态会讲清楚。 */}
            <Note tone={machine.banned ? "danger" : "default"}>
              {machine.banned ? t("share.machineBannedNote") : t("share.machineOfflineNote")}
            </Note>
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "10px 18px 10px" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.detected")}</span>
          {rows.length > 0 ? <span className="gx-card__hint">{t("share.syncHint")}</span> : null}
        </div>
        <div style={{ padding: "0 18px 16px" }}>
          {rows.length === 0 ? (
            <div style={{ borderTop: "1px solid var(--gx-line)" }}>
              <EmptyState title={t("share.machineEmptyTitle")} hint={t("share.machineEmptyHint")} />
            </div>
          ) : (
            <>
              {rows.map((row) => (
                <CapabilityRow
                  key={row.cid}
                  row={row}
                  busy={busy}
                  local={isLocal}
                  onToggle={(on) => void toggle(row, on)}
                  onForce={() => forceClose(row)}
                  onAuthorize={() => void authorize(row)}
                />
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)", opacity: 0.55 }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--gx-muted)", color: "var(--gx-faint)" }}>
                  <IconGpu size={18} />
                </span>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{t("share.gpu")}</span>
                <Pill>{t("today.soon")}</Pill>
              </div>
              <div style={{ marginTop: 12 }}>
                <Note>{t("share.detectedHint")}</Note>
              </div>
            </>
          )}
        </div>
      </Card>

      {current && form ? (
        <Card className="gx-rise gx-rise--2">
          <CardHead
            title={current.cid}
            // 保存写到哪台，就在表单头上写哪台。几台机器上的 cid 一模一样，只看标题分不出来。
            hint={t("share.editingOn", { name: nodeDisplayName(machine) })}
            action={
              rows.length > 1 ? (
                <Seg value={current.cid} onChange={selectContribution} options={rows.map((row) => ({ value: row.cid, label: row.cid }))} />
              ) : null
            }
          />
          <div style={{ padding: "0 22px 20px", display: "flex", flexDirection: "column", gap: 22 }}>
            <GroupJoin
              choices={modelChoices}
              picked={form.groups}
              offCatalog={offCatalog}
              onChange={(next) => edit({ ...form, groups: next })}
            />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
              <Field label={t("share.seats")} hint={t("share.seatsHint", { value: form.seats })}>
                <input
                  className="gx-input gx-input--mono"
                  type="number"
                  min={1}
                  max={10}
                  value={form.seats}
                  onChange={(event) => edit({ ...form, seats: Number(event.target.value) || 1 })}
                />
              </Field>
              <Field label={t("share.concurrency")} hint={t("share.concurrencyHint", { value: form.seatConcurrency })}>
                <input
                  className="gx-input gx-input--mono"
                  type="number"
                  min={1}
                  max={16}
                  value={form.seatConcurrency}
                  onChange={(event) => edit({ ...form, seatConcurrency: Number(event.target.value) || 1 })}
                />
              </Field>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.quota")}</span>
                <span className="gx-card__hint">{t("share.quotaHint")}</span>
              </div>
              {form.quota.map((item, index) => (
                <div key={`${item.unit}-${index}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 90px 36px", gap: 10, alignItems: "center" }}>
                  <select
                    className="gx-input"
                    value={item.unit}
                    onChange={(event) => {
                      const quota = [...form.quota];
                      quota[index] = { ...item, unit: event.target.value };
                      edit({ ...form, quota });
                    }}
                  >
                    {Array.from(new Set([item.unit, ...COMMON_UNITS])).filter(Boolean).map((unit) => (
                      // 别的行已经占了的单位在这里是灰的：选中它只会换来一条保存失败。
                      <option key={unit} value={unit} disabled={unit !== item.unit && usedUnits.has(unit)}>
                        {unitLabel(unit, t)} · {unit}
                      </option>
                    ))}
                  </select>
                  <input
                    className="gx-input gx-input--mono"
                    type="number"
                    min={1}
                    value={item.limit}
                    onChange={(event) => {
                      const quota = [...form.quota];
                      quota[index] = { ...item, limit: Number(event.target.value) || 0 };
                      edit({ ...form, quota });
                    }}
                  />
                  <select
                    className="gx-input"
                    value={item.window}
                    onChange={(event) => {
                      const quota = [...form.quota];
                      quota[index] = { ...item, window: event.target.value };
                      edit({ ...form, quota });
                    }}
                  >
                    {/* 5h 排在最前：Claude / Codex 的订阅额度本来就是每 5 小时刷新一轮，
                        照上游的说法填，不用自己换算成「一天多少」—— 换算出来的数摊平到
                        一整天，早上就能把量跑完，然后在上游那儿撞限流。 */}
                    {["5h", "day", "week", "month", "total"].map((window) => (
                      <option key={window} value={window}>
                        {window}
                      </option>
                    ))}
                  </select>
                  <Btn
                    tone="ghost"
                    small
                    aria-label="remove"
                    onClick={() => edit({ ...form, quota: form.quota.filter((_, at) => at !== index) })}
                  >
                    ×
                  </Btn>
                </div>
              ))}
              <Btn
                tone="ghost"
                small
                icon={<IconPlus size={14} />}
                // 新行落在第一个还没被占的单位上。四个单位都配满了就没得加了，
                // 再加只能是重复的那条。
                disabled={!freeUnit}
                title={freeUnit ? undefined : t("share.quotaAllUsed")}
                onClick={() => {
                  if (!freeUnit) return;
                  edit({ ...form, quota: [...form.quota, { unit: freeUnit, limit: 1_000_000, window: "day" }] });
                }}
              >
                {t("share.quotaAdd")}
              </Btn>
            </div>

            {/* 上游余量紧挨着额度 —— 这两个数放在一起才有意义：
                上面那个是「你打算放多少出去」，下面这个是「上游此刻还让你跑多少」。
                上面填得比下面宽，机器就会在 Claude / Codex 那儿撞限流，
                而共享设置页上看起来一切正常。 */}
            <UpstreamUsageBlock row={current} />

            {/* 下限紧跟在余量下面：主人要看着此刻那几个数才决定线划在哪。
                它是这一页里唯一一处「让机器少接活」的设置，所以被它挡住的时候
                要在这儿把话说全 —— 剩多少、线在哪、什么时候自己回来。 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.floor")}</span>
                <span className="gx-card__hint">{t("share.floorHint")}</span>
              </div>
              {current.upstreamBlock ? (
                <Note tone="warn">
                  {t("share.floorBlocked", {
                    window: current.upstreamBlock.window || t("share.floorAnyWindow"),
                    left: current.upstreamBlock.left.toFixed(0),
                    percent: current.upstreamBlock.percent,
                    bucket: current.upstreamBlock.bucket || "-",
                  })}
                </Note>
              ) : null}
              {form.floors.map((item, index) => (
                <div
                  key={`${item.window}-${index}`}
                  style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 36px", gap: 10, alignItems: "center" }}
                >
                  <select
                    className="gx-input"
                    value={item.window}
                    onChange={(event) => {
                      const floors = [...form.floors];
                      floors[index] = { ...item, window: event.target.value };
                      edit({ ...form, floors });
                    }}
                  >
                    {floorWindows.map((window) => (
                      <option key={window || "any"} value={window} disabled={window !== item.window && usedWindows.has(window)}>
                        {window || t("share.floorAnyWindow")}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      className="gx-input gx-input--mono"
                      type="number"
                      min={0}
                      max={100}
                      value={item.percent}
                      onChange={(event) => {
                        // 夹在 0–100：服务端也会拦，但那得等主人点了保存才知道。
                        const percent = Math.max(0, Math.min(100, Number(event.target.value) || 0));
                        const floors = [...form.floors];
                        floors[index] = { ...item, percent };
                        edit({ ...form, floors });
                      }}
                    />
                    <span className="gx-card__hint">%</span>
                  </div>
                  {/* 此刻这个窗口还剩多少。没有这句的话，主人填百分比全靠猜 ——
                      而「未报」和「剩 0」是两件事，必须分开说。 */}
                  <span className="gx-card__hint">
                    {observedLeft[item.window] === undefined
                      ? item.window === "" && Object.keys(observedLeft).length > 0
                        ? t("share.floorNowLowest", { value: Math.min(...Object.values(observedLeft)).toFixed(0) })
                        : t("share.floorNoData")
                      : t("share.floorNow", { value: observedLeft[item.window].toFixed(0) })}
                  </span>
                  <Btn
                    tone="ghost"
                    small
                    aria-label="remove"
                    // 至少留一条：这一项是必填的。全删光之后界面上什么都没有，
                    // 主人会以为「没有保护」，而服务端那边其实补了一条默认的。
                    disabled={form.floors.length <= 1}
                    title={form.floors.length <= 1 ? t("share.floorKeepOne") : undefined}
                    onClick={() => edit({ ...form, floors: form.floors.filter((_, at) => at !== index) })}
                  >
                    ×
                  </Btn>
                </div>
              ))}
              <Btn
                tone="ghost"
                small
                icon={<IconPlus size={14} />}
                disabled={freeWindow === undefined}
                title={freeWindow === undefined ? t("share.floorAllUsed") : undefined}
                onClick={() => {
                  if (freeWindow === undefined) return;
                  edit({ ...form, floors: [...form.floors, { window: freeWindow, percent: 20 }] });
                }}
              >
                {t("share.floorAdd")}
              </Btn>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.window")}</span>
                <span className="gx-card__hint">
                  {Intl.DateTimeFormat().resolvedOptions().timeZone} · {t("share.windowHint")}
                </span>
              </div>
              <HourBar
                hours={form.hours}
                onToggle={(hour) => {
                  const hours = [...form.hours];
                  hours[hour] = !hours[hour];
                  edit({ ...form, hours });
                }}
              />
            </div>
          </div>

          <div className="gx-row__foot">
            <span>{changes > 0 ? t("share.dirty", { value: changes }) : ""}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <Btn tone="ghost" small disabled={changes === 0 || busy} onClick={() => setDraft(null)}>
                {t("common.discard")}
              </Btn>
              <Btn tone="accent" small loading={busy} disabled={changes === 0} onClick={() => void save()}>
                {t("share.submit")}
              </Btn>
            </span>
          </div>
        </Card>
      ) : null}
    </>
  );

  return (
    <>
      <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
      {modalHolder}
      <div className="gx-body">
        {/* 只有一项时不摆左列：一列里就一行，占掉 260 宽什么也没说。补上的「这台电脑」也算一项。 */}
        {machines.length + (localGap ? 1 : 0) > 1 ? (
          <div className="gx-split">
            <MachineRail
              machines={machines}
              selected={selectedKey}
              localNodeId={localNodeId}
              localGap={localGap}
              localSelected={selectedKey === THIS_COMPUTER}
              query={query}
              onQuery={setQuery}
              onSelect={selectMachine}
              onSelectLocal={() => selectMachine(THIS_COMPUTER)}
            />
            <div className="gx-split__main">{detail}</div>
          </div>
        ) : (
          detail
        )}
      </div>
    </>
  );
}

/**
 * 这台电脑不在名下机器里时，右边摆的那一块：说清楚为什么不在、从哪儿接回来。
 *
 * 两种情形分开说。解绑过的那种本机还拿着旧令牌、自认为配着，主人在别处看到的
 * 只是「正在连接平台」—— 不点破「平台已经不认它了」，他会一直等下去。
 * 重新配对是作为新机器接入：能力默认关着，之前的额度和时段不会跟过来，这也得提前说。
 */
function ThisComputerCard({ gap, nodeId }: { gap: LocalGap; nodeId: string }) {
  const { t } = useLocale();
  const router = useRouter();
  const detached = gap === "detached";
  return (
    <Card className="gx-rise gx-rise--1">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px 12px" }}>
        <span
          style={{
            width: 36,
            height: 36,
            flex: "0 0 auto",
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            background: "var(--gx-muted)",
            color: "var(--gx-soft)",
          }}
        >
          <IconMonitor size={19} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{t("account.thisComputer")}</span>
          {/* 解绑过的把旧节点报出来：对得上账户页、执行记录里那台，排查时不用去翻本机文件。 */}
          {detached && nodeId ? (
            <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 4 }}>
              {t("share.localDetachedNode", { node: nodeId })}
            </span>
          ) : null}
        </span>
        <Pill tone={detached ? "warn" : "default"}>{t("share.localOutOfPool")}</Pill>
      </div>
      <div style={{ padding: "0 18px 16px" }}>
        <div style={{ borderTop: "1px solid var(--gx-line)" }}>
          <EmptyState
            title={detached ? t("share.localDetachedTitle") : t("share.localUnpairedTitle")}
            hint={
              <span style={{ display: "inline-block", maxWidth: 520, lineHeight: 1.7 }}>
                {detached ? t("share.localDetachedHint") : t("share.localUnpairedHint")}
              </span>
            }
            action={
              <Btn tone="accent" onClick={() => router.push("/provider/pair")}>
                {detached ? t("share.localRepair") : t("share.localPair")}
              </Btn>
            }
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * 一条能力。
 *
 * 「你自己关掉了」和「那台机器现在干不了」是两件事：前者给开关，后者把原因原样摆出来。
 * 修的办法看是哪台 —— 这台电脑给「去授权」，要调本机 bridge 拉起登录流程；
 * 别的机器浏览器够不到它的 bridge，只能说清楚去哪儿修。
 */
function CapabilityRow({
  row,
  busy,
  local,
  onToggle,
  onForce,
  onAuthorize,
}: {
  row: ContributionView;
  busy: boolean;
  local: boolean;
  onToggle: (on: boolean) => void;
  /** 「正在收尾」时的「立即关闭」。 */
  onForce: () => void;
  onAuthorize: () => void;
}) {
  const { t } = useLocale();
  // 正在收尾的画成关着：主人的意图是关，服务端也已经不给它派新单了。
  const closing = isClosing(row);
  const on = row.status === "active" && !closing;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)" }}>
      <span
        style={{
          width: 34,
          height: 34,
          flex: "0 0 auto",
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          background: on ? "var(--gx-accent-soft)" : "var(--gx-muted)",
          color: on ? "var(--gx-accent)" : "var(--gx-faint)",
        }}
      >
        <IconSparkle size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{row.cid}</span>
        {/* 不可用时副行换成原因。「llm.chat · codex_chatgpt」谁都猜得到，
            「登录态过期了，去敲这条命令」才是这一刻要说的话。 */}
        <span
          className={row.available ? "gx-mono" : undefined}
          title={row.available ? undefined : row.unavailableReason}
          style={{
            display: "block",
            fontSize: 11.5,
            color: row.available ? "var(--gx-faint)" : "var(--gx-warn-ink)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.available ? `${row.kind} · ${row.provider}` : row.unavailableReason || t("share.unavailable")}
        </span>
      </span>
      {/* 余量到线：开关还是开着的，但此刻不接单。牌子和开关摆在一起，
          免得主人以为是开关没点上 —— 下面那张卡里有完整的一句话。 */}
      {row.upstreamBlock ? <Pill tone="warn">{t("share.floorHold")}</Pill> : null}
      {row.seatsBound > 0 ? <Pill tone="accent">{t("share.bound", { value: row.seatsBound })}</Pill> : null}
      {row.available ? (
        <>
          {/* 开关**不因座位绑定而禁用**：座位是会话亲和，最后一条请求结束之后
              还要空闲满一分钟才释放，拿它挡住关闭，主人点完最后一次还得干等。
              真正不该被打断的是在跑的请求，那件事由服务端排队处理，不是在这里灰掉按钮。 */}
          <Pill tone={closing ? "warn" : on ? "ok" : "default"}>
            {closing ? t("close.closingPill") : on ? t("share.on") : t("share.off")}
          </Pill>
          {closing ? <LinkBtn onClick={onForce}>{t("close.forceNow")}</LinkBtn> : null}
          <Switch checked={on} disabled={busy} label={t("share.enable")} onChange={onToggle} />
        </>
      ) : (
        <>
          <IconAlert size={16} style={{ flex: "0 0 auto", color: "var(--gx-warn)" }} />
          {local ? (
            <Btn tone="soft" small loading={busy} onClick={onAuthorize}>
              {t("share.authorize")}
            </Btn>
          ) : (
            <span className="gx-card__hint" style={{ whiteSpace: "nowrap" }}>
              {t("share.fixOnMachine")}
            </span>
          )}
        </>
      )}
    </div>
  );
}


/**
 * 这条通道背后那个上游账号此刻还剩多少。
 *
 * 数据是节点从**本来就要发的**那些中转请求的响应头里捎回来的 —— 不额外打上游，
 * 所以不消耗主人的额度、也不在他账号上留下多余的调用。代价是机器闲着时这个数
 * 不会更新，因此观测时刻必须显示出来：三小时前的余量不能被当成此刻的。
 *
 * 上游没报的项显示「未报」而不是 0：那两件事在这一页上会导出完全相反的动作。
 */
function UpstreamUsageBlock({ row }: { row: ContributionView | null }) {
  const { t } = useLocale();
  const buckets = row?.upstreamUsage?.buckets ?? [];
  if (!row) {
    return null;
  }
  // 没数据时**照样把这一块画出来**，只是把「还没有」说清楚。
  //
  // 原先这里是 return null —— 于是一个来找这个数的人在页面上什么都看不到，
  // 分不清是「还没采到」还是「压根没这个功能」。而这两件事的下一步完全不同：
  // 前者是等一条请求经过这台机器，后者是去提工单。
  if (buckets.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.upstream")}</span>
        <span className="gx-card__hint">{t("share.upstreamEmpty")}</span>
      </div>
    );
  }
  const observed = row.upstreamUsageAt || row.upstreamUsage?.observedAt || "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.upstream")}</span>
        <span className="gx-card__hint">{t("share.upstreamHint", { at: formatObserved(observed) })}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        {buckets.map((bucket) => (
          <div className="gx-quota" key={bucket.bucket}>
            <div className="gx-quota__label">
              {/* 窗口记法（5h / 7d）优先，认不出来才显示上游自己的叫法。 */}
              <span title={bucket.bucket}>{bucket.window || bucket.bucket}</span>
              {/* 存的是**已用**，显示的是**还剩** —— 主人要的是「还能跑多少」。
                  换算只在这一处做：Claude 报已用、Codex 屏幕上报剩余，两边各转一次
                  的话总有一处会转反，而转反之后数字看着仍然合理，没人会发现。 */}
              <span className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>
                {bucket.usedPercent === undefined
                  ? t("share.upstreamUnknown")
                  : `${t("share.upstreamLeft")} ${Math.max(0, 100 - bucket.usedPercent).toFixed(0)}%`}
              </span>
            </div>
            {bucket.usedPercent === undefined ? null : (
              <Meter used={Math.round(bucket.usedPercent)} limit={100} warned={bucket.usedPercent >= 80} />
            )}
            {bucket.reset ? (
              <span style={{ fontSize: 11, color: "var(--gx-faint)" }}>
                {t("share.upstreamReset")} {bucket.reset}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatObserved(at: string): string {
  if (!at) return "—";
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "—";
  return time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 接哪些模型、每个模型接哪几档。
 *
 * 厂商由车道自己定死了（relay_claude 就是 Claude），所以这里从模型开始：一个模型一行，
 * 点开才露出它在卖的**档次**。档次是平台在一个模型上卖的档（「标准」「深度」……），
 * 价和思考深度都挂在它上面 —— **加入了才接得到那一档的单**。
 *
 * 档次是这一页唯一的范围设置：勾中哪几档，这台机器就提供哪几档的能力。
 * 一个模型一档都不勾，它的单就不会派到这台机器上。
 *
 * 一个都不勾 = **不限**：什么档的单都接，也包括以后新加的档。这是存量车道的状态，
 * 也是绝大多数人想要的 —— 所以它是默认，而不是「一个都没选、什么都接不到」。
 * 那种默认会在迁移那一刻让全网机器一起停摆，而界面上每台都还显示着共享中。
 *
 * 折叠是有代价的（一眼看不全自己接了什么），所以折起来的那一行要把结论说完：
 * 接了几档、这台机器上有没有这个模型。展开只是为了改。
 */
function GroupJoin({
  choices,
  picked,
  offCatalog,
  onChange,
}: {
  choices: ModelChoice[];
  picked: string[];
  offCatalog: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useLocale();
  // 一次只开一个：这一屏下面还有额度、时段要填，几个模型同时摊开会把它们挤出视野。
  const [open, setOpen] = useState("");
  const unrestricted = picked.length === 0;
  const all = useMemo(() => choices.flatMap((row) => row.groups.map((group) => group.groupId)), [choices]);

  if (choices.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.groups")}</span>
        <Note>{t("share.groupsCatalogEmpty")}</Note>
      </div>
    );
  }

  // 全都勾上等于不限。存成空数组，这样平台以后新加的分组会自动接上 ——
  // 存一份当时的全量名单，新分组永远进不来，而主人以为自己什么都接。
  const commit = (next: string[]) => onChange(next.length === all.length ? [] : next);
  // 从「不限」点第一下：把全部分组先铺上，再在这份底稿上改 —— 直接只留点中的那个的话，
  // 主人点一下「深度」就从「什么都接」变成了「只接深度」，那不是他要表达的意思。
  const base = () => (unrestricted ? all : picked);

  const toggle = (groupId: string) => {
    const from = base();
    commit(from.includes(groupId) ? from.filter((id) => id !== groupId) : [...from, groupId]);
  };

  // 整个模型一起开关。常见的决定是「这个模型我全接」或者「这个模型不接」，
  // 逐档点一遍既慢又容易漏掉一个 —— 漏掉的那一档会安静地继续接单。
  const toggleModel = (row: ModelChoice) => {
    const ids = row.groups.map((group) => group.groupId);
    const from = base();
    const joined = ids.every((id) => from.includes(id));
    commit(joined ? from.filter((id) => !ids.includes(id)) : Array.from(new Set([...from, ...ids])));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.groups")}</span>
        <span className="gx-card__hint">{unrestricted ? t("share.groupsAll") : t("share.groupsHint")}</span>
      </div>
      <div style={{ border: "1px solid var(--gx-line)", borderRadius: 10, overflow: "hidden" }}>
        {choices.map((row, index) => {
          const ids = row.groups.map((group) => group.groupId);
          const joined = unrestricted ? ids : ids.filter((id) => picked.includes(id));
          const expanded = open === row.modelId;
          return (
            <div key={row.modelId}>
              <button
                type="button"
                className="gx-row"
                style={{
                  gridTemplateColumns: "1fr auto auto 16px",
                  cursor: "pointer",
                  borderTop: index === 0 ? "none" : undefined,
                }}
                onClick={() => setOpen(expanded ? "" : row.modelId)}
                aria-expanded={expanded}
              >
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.modelName}
                  </span>
                  <span
                    className="gx-mono"
                    style={{ fontSize: 11.5, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {row.modelId}
                  </span>
                </span>
                {/* 「这台机器有没有」是上游说了算的事实，和「我接不接」分开说：
                    接了但机器上没有，照样一单都接不到 —— 而那不是设置错了。 */}
                <span style={{ fontSize: 12 }}>
                  {row.available ? <Pill tone="ok">{t("share.modelsOnMachine")}</Pill> : <Pill>{t("share.modelsOffMachine")}</Pill>}
                </span>
                <span style={{ fontSize: 12 }}>
                  {unrestricted ? (
                    <Pill tone="ok">{t("share.groupsAllPill")}</Pill>
                  ) : (
                    <Pill tone={joined.length > 0 ? "accent" : "default"}>
                      {t("share.groupJoined", { joined: joined.length, total: ids.length })}
                    </Pill>
                  )}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "var(--gx-faint)",
                    display: "inline-flex",
                    justifyContent: "flex-end",
                  }}
                >
                  {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                </span>
              </button>
              {expanded ? (
                <div
                  style={{
                    padding: "2px 16px 14px",
                    background: "var(--gx-muted)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <span className="gx-card__hint">{t("share.groupsPickHint")}</span>
                    <LinkBtn onClick={() => toggleModel(row)}>
                      {joined.length === ids.length ? t("share.groupsClear") : t("share.groupsPickAll")}
                    </LinkBtn>
                  </div>
                  {/* 一档一行，右边是**结算价**：这一档跑一百万 token 给这台机器记多少积分。
                      列和「模型」那一页的档次表一一对应（ModelDetail），两页看同一件事
                      就该长得一样；那一页只读，这一页点一下就是加入或退出。 */}
                  <div>
                    <div className="gx-th" style={{ gridTemplateColumns: GROUP_COLUMNS, padding: "6px 0" }}>
                      <span>{t("share.groupCol.group")}</span>
                      <span style={{ textAlign: "center" }}>{t("share.groupCol.join")}</span>
                      <span style={{ textAlign: "right" }}>{t("share.groupCol.input")}</span>
                      <span style={{ textAlign: "right" }}>{t("share.groupCol.output")}</span>
                      <span style={{ textAlign: "right" }}>{t("share.groupCol.cache")}</span>
                    </div>
                    {row.groups.map((group) => {
                      const active = unrestricted || picked.includes(group.groupId);
                      return (
                        <button
                          key={group.groupId}
                          type="button"
                          className="gx-row"
                          style={{ gridTemplateColumns: GROUP_COLUMNS, padding: "9px 0", cursor: "pointer" }}
                          onClick={() => toggle(group.groupId)}
                          aria-pressed={active}
                        >
                          <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontWeight: active ? 600 : 500, color: active ? "var(--gx-accent)" : "inherit" }}>
                                {group.name}
                              </span>
                            </span>
                            {group.summary ? (
                              <span style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>{group.summary}</span>
                            ) : null}
                          </span>
                          <span style={{ textAlign: "center", fontSize: 12 }}>
                            {active ? <Pill tone="ok">{t("share.groupJoinedYes")}</Pill> : <Pill>{t("share.groupJoinedNo")}</Pill>}
                          </span>
                          <span className="gx-mono" style={{ textAlign: "right" }}>{points(group.inputPrice)}</span>
                          <span className="gx-mono" style={{ textAlign: "right" }}>{points(group.outputPrice)}</span>
                          <span className="gx-mono" style={{ textAlign: "right", color: "var(--gx-soft)" }}>
                            {points(group.cachePrice)}
                          </span>
                        </button>
                      );
                    })}
                    <span className="gx-card__hint" style={{ display: "block", paddingTop: 8 }}>
                      {t("share.groupsPriceHint")}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* 机器上有、平台没在卖的那些模型。不说的话这件事无处可查：主人看着本机的
          claude 里明明有它，清单里却没有，只会以为是控制台漏了。 */}
      {offCatalog.length > 0 ? <Note>{t("share.modelsOffCatalog", { value: offCatalog.join("、") })}</Note> : null}
    </div>
  );
}
