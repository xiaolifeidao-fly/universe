"use client";

import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchBizLines } from "@/api/bizline.api";

const STORAGE_KEY = "zhangtian-bottle-business-line";

const DEFAULT_BUSINESS_LINES = [
  { id: "whatsapp", code: "WHATSAPP", label: "WhatsApp", status: "active" },
] as const;

export type BusinessLineId = string;

export interface BusinessLine {
	id: BusinessLineId;
	code: string;
	label: string;
	status: "active";
}

interface BusinessLineContextValue {
  activeBusinessLine: BusinessLine;
  businessLines: readonly BusinessLine[];
  setActiveBusinessLine: (businessLineId: BusinessLineId) => void;
  refreshBusinessLines: () => Promise<void>;
}

const BusinessLineContext = createContext<BusinessLineContextValue | null>(null);

function getInitialBusinessLine(): BusinessLineId {
	if (typeof window === "undefined") return DEFAULT_BUSINESS_LINES[0].id;
	const saved = window.localStorage.getItem(STORAGE_KEY);
	return saved || DEFAULT_BUSINESS_LINES[0].id;
}

export function BusinessLineProvider({ children }: PropsWithChildren) {
  const [activeBusinessLineId, setActiveBusinessLine] = useState<BusinessLineId>(getInitialBusinessLine);
	const [businessLines, setBusinessLines] = useState<readonly BusinessLine[]>(DEFAULT_BUSINESS_LINES);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, activeBusinessLineId);
  }, [activeBusinessLineId]);

	const refreshBusinessLines = useCallback(async () => {
		const rows = await fetchBizLines();
		if (rows.length === 0) {
			setBusinessLines([]);
			return;
		}
		const lines: BusinessLine[] = rows.map((row) => ({
			id: row.code,
			code: row.code.toUpperCase(),
			label: row.name || row.code,
			status: "active",
		}));
		setBusinessLines(lines);
		setActiveBusinessLine((current) => lines.some((line) => line.id === current) ? current : lines[0].id);
	}, []);

	useEffect(() => {
		void refreshBusinessLines().catch(() => {
			// 业务线表还未初始化时，保持 WhatsApp 默认线，控制台仍能读取交付数据。
		});
	}, [refreshBusinessLines]);

  const value = useMemo<BusinessLineContextValue>(() => ({
		activeBusinessLine: businessLines.find((line) => line.id === activeBusinessLineId) ?? businessLines[0] ?? DEFAULT_BUSINESS_LINES[0],
    businessLines,
    setActiveBusinessLine,
    refreshBusinessLines,
  }), [activeBusinessLineId, businessLines, refreshBusinessLines]);

  return <BusinessLineContext.Provider value={value}>{children}</BusinessLineContext.Provider>;
}

export function useBusinessLine() {
  const context = useContext(BusinessLineContext);
  if (!context) throw new Error("useBusinessLine must be used within BusinessLineProvider");
  return context;
}
