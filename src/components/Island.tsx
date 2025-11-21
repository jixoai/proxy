import { useIsland, type IslandTip } from "./useIsland";
import { useEffect, useRef } from "react";

export function Island() {
  const { tips } = useIsland();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverRef.current) return;

    if (tips.length > 0) {
      // 显示 popover
      popoverRef.current.showPopover();
    } else {
      // 隐藏 popover
      try {
        popoverRef.current.hidePopover();
      } catch (e) {
        // hidePopover 可能在 popover 未显示时抛出错误，忽略
      }
    }
  }, [tips.length]);

  return (
    <div
      ref={popoverRef}
      popover="manual"
      className="m-0 border-0 bg-transparent p-0 pointer-events-auto overflow-visible"
      style={{
        // Popover 默认居中，我们需要定位到顶部
        inset: "unset",
        top: "1rem",
        left: "50%",
        transform: "translateX(-50%)",
      }}
    >
      <div className="flex gap-2">
        {tips.map((tip) => (
          <IslandTipItem key={tip.id} tip={tip} />
        ))}
      </div>
    </div>
  );
}

function IslandTipItem({ tip }: { tip: IslandTip }) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡
    e.preventDefault(); // 阻止默认行为
    tip.onClick?.();
  };

  return (
    <div
      className="bg-black text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 cursor-pointer hover:scale-105 transition-all duration-300 animate-in slide-in-from-top-2"
      onClick={handleClick}
    >
      <div className="flex items-center gap-2">
        {tip.icon}
        <span className="text-sm font-medium">{tip.text}</span>
      </div>
      {tip.subtext && <div className="text-xs opacity-70">{tip.subtext}</div>}
    </div>
  );
}
