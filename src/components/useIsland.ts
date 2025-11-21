import { useState, useCallback, useRef, useEffect } from "react";

export interface IslandTip {
  id: string;
  icon: React.ReactNode;
  text: string;
  subtext?: string;
  onClick?: () => void;
}

interface IslandContextValue {
  tips: IslandTip[];
  addTip: (tip: IslandTip) => void;
  removeTip: (id: string) => void;
  clearTips: () => void;
}

// 全局 Island 状态管理
const islandListeners = new Set<(tips: IslandTip[]) => void>();
let currentTips: IslandTip[] = [];

function notifyListeners() {
  islandListeners.forEach((listener) => listener([...currentTips]));
}

export function useIsland() {
  const [tips, setTips] = useState<IslandTip[]>(currentTips);

  useEffect(() => {
    const listener = (newTips: IslandTip[]) => {
      setTips(newTips);
    };
    islandListeners.add(listener);
    return () => {
      islandListeners.delete(listener);
    };
  }, []);

  const addTip = useCallback((tip: IslandTip) => {
    // 检查是否已存在相同的 tip
    const existingIndex = currentTips.findIndex((t) => t.id === tip.id);
    if (existingIndex !== -1) {
      const existing = currentTips[existingIndex];
      if (existing) {
        // 如果内容相同，不需要更新
        if (
          existing.text === tip.text &&
          existing.subtext === tip.subtext
        ) {
          // 只更新 onClick，不触发重新渲染
          if (tip.onClick) {
            currentTips[existingIndex] = { ...existing, onClick: tip.onClick };
          }
          return;
        }
      }
    }

    // 如果已存在相同 id 的 tip，先删除
    currentTips = currentTips.filter((t) => t.id !== tip.id);
    currentTips.push(tip);
    notifyListeners();
  }, []);

  const removeTip = useCallback((id: string) => {
    currentTips = currentTips.filter((t) => t.id !== id);
    notifyListeners();
  }, []);

  const clearTips = useCallback(() => {
    currentTips = [];
    notifyListeners();
  }, []);

  return {
    tips,
    addTip,
    removeTip,
    clearTips,
  };
}
