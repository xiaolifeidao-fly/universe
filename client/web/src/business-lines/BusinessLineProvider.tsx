"use client";

import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchBizLines } from "@/api/bizline.api";
import { isAuthenticated } from "@/utils/auth";

const STORAGE_KEY = "zhangtian-bottle-business-line";

export type BusinessLineId = string;

export interface BusinessLine {
	id: BusinessLineId;
	code: string;
	label: string;
	status: "active";
	/** 当前登录用户对这条业务线的权限，由服务端随列表返回，不是本地推断的。 */
	canWrite: boolean;
	canManage: boolean;
}

const EMPTY_BUSINESS_LINE: BusinessLine = {
	id: "",
	code: "",
	label: "",
	status: "active",
	canWrite: false,
	canManage: false,
};

interface BusinessLineContextValue {
  activeBusinessLine: BusinessLine;
  businessLines: readonly BusinessLine[];
  businessLinesLoaded: boolean;
  setActiveBusinessLine: (businessLineId: BusinessLineId) => void;
  refreshBusinessLines: () => Promise<void>;
}

const BusinessLineContext = createContext<BusinessLineContextValue | null>(null);

function getInitialBusinessLine(): BusinessLineId {
	if (typeof window === "undefined") return "";
	const saved = window.localStorage.getItem(STORAGE_KEY);
	return saved || "";
}

export function BusinessLineProvider({ children }: PropsWithChildren) {
  const [activeBusinessLineId, setActiveBusinessLine] = useState<BusinessLineId>(getInitialBusinessLine);
  const [businessLines, setBusinessLines] = useState<readonly BusinessLine[]>([]);
	const [businessLinesLoaded, setBusinessLinesLoaded] = useState(false);

  useEffect(() => {
		if (!businessLinesLoaded || !activeBusinessLineId) return;
    window.localStorage.setItem(STORAGE_KEY, activeBusinessLineId);
	}, [activeBusinessLineId, businessLinesLoaded]);

	const refreshBusinessLines = useCallback(async () => {
		try {
			const rows = await fetchBizLines();
			const lines: BusinessLine[] = rows.map((row) => ({
				id: row.code,
				code: row.code.toUpperCase(),
				label: row.name || row.code,
				status: "active",
				canWrite: row.canWrite,
				canManage: row.canManage,
			}));
			setBusinessLines(lines);
			setActiveBusinessLine((current) => lines.some((line) => line.id === current) ? current : (lines[0]?.id ?? ""));
		} finally {
			setBusinessLinesLoaded(true);
		}
	}, []);

	useEffect(() => {
		if (!isAuthenticated()) {
			setBusinessLines([]);
			setActiveBusinessLine("");
			setBusinessLinesLoaded(true);
			return;
		}
		void refreshBusinessLines().catch(() => {
			// 请求失败时不猜测业务线，避免把用户带到无权访问的数据域。
		});
	}, [refreshBusinessLines]);

	const selectBusinessLine = useCallback((businessLineId: BusinessLineId) => {
		setActiveBusinessLine((current) => (
			businessLines.some((line) => line.id === businessLineId) ? businessLineId : current
		));
	}, [businessLines]);

  const value = useMemo<BusinessLineContextValue>(() => ({
		activeBusinessLine: businessLines.find((line) => line.id === activeBusinessLineId) ?? EMPTY_BUSINESS_LINE,
    businessLines,
		businessLinesLoaded,
    setActiveBusinessLine: selectBusinessLine,
    refreshBusinessLines,
  }), [activeBusinessLineId, businessLines, businessLinesLoaded, refreshBusinessLines, selectBusinessLine]);

  return <BusinessLineContext.Provider value={value}>{children}</BusinessLineContext.Provider>;
}

export function useBusinessLine() {
  const context = useContext(BusinessLineContext);
  if (!context) throw new Error("useBusinessLine must be used within BusinessLineProvider");
  return context;
}
