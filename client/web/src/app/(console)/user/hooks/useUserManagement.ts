"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchUsers, type UserQuery, type UserRecord } from "../api/user.api";

const DEFAULT_QUERY: Required<UserQuery> = {
  pageIndex: 1,
  pageSize: 10,
  keyword: "",
  role: "",
  status: "",
};

export function useUserManagement() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState<Required<UserQuery>>(DEFAULT_QUERY);

  const refresh = useCallback(async (changes: Partial<UserQuery> = {}) => {
    const next = { ...query, ...changes };
    setLoading(true);
    try {
      const page = await fetchUsers(next);
      setUsers(page.data);
      setTotal(page.total);
      setQuery(next);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, []); // The initial request deliberately starts from DEFAULT_QUERY.

  return { users, total, loading, query, refresh };
}
