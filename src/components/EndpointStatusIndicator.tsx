import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ForwardStats } from "@/hooks/useForwardStats";

interface EndpointStatusIndicatorProps {
  stats: ForwardStats | null;
  size?: "sm" | "md" | "lg";
}

/**
 * 计算延迟颜色
 * 200ms 以下: 绿色
 * 200-1000ms: 黄色渐变
 * 1000ms 以上: 红色
 */
function getLatencyColor(avgLatency: number, dormancyFactor: number): string {
  let h: number, s: number, l: number;

  if (avgLatency <= 200) {
    // 绿色 hsl(142, 76%, 36%)
    h = 142;
    s = 76;
    l = 36;
  } else if (avgLatency <= 1000) {
    // 绿到黄到橙渐变
    const t = (avgLatency - 200) / 800;
    // 绿(142) -> 黄(45) -> 橙(25)
    if (t < 0.5) {
      h = 142 - (142 - 45) * (t * 2);
    } else {
      h = 45 - (45 - 25) * ((t - 0.5) * 2);
    }
    s = 76 + (90 - 76) * t;
    l = 36 + (50 - 36) * t;
  } else {
    // 红色 hsl(0, 84%, 60%)
    h = 0;
    s = 84;
    l = 60;
  }

  // 应用休眠因子 - 逐渐变灰
  s = s * (1 - dormancyFactor * 0.9);
  l = l + (50 - l) * dormancyFactor * 0.5;

  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * 计算失败率颜色
 * 0%: 绿色
 * 50%: 黄色
 * 100%: 红色
 */
function getFailureRateColor(failureRate: number, dormancyFactor: number): string {
  let h: number, s: number, l: number;

  if (failureRate <= 0.1) {
    // 绿色
    h = 142;
    s = 76;
    l = 36;
  } else if (failureRate <= 0.5) {
    // 绿到黄渐变
    const t = (failureRate - 0.1) / 0.4;
    h = 142 - (142 - 45) * t;
    s = 76;
    l = 36 + 14 * t;
  } else {
    // 黄到红渐变
    const t = (failureRate - 0.5) / 0.5;
    h = 45 - 45 * t;
    s = 76 + 8 * t;
    l = 50 + 10 * t;
  }

  // 应用休眠因子
  s = s * (1 - dormancyFactor * 0.9);
  l = l + (50 - l) * dormancyFactor * 0.5;

  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * 获取休眠状态的灰色
 */
function getDormantColor(): string {
  return "hsl(0, 0%, 70%)";
}

const sizeMap = {
  sm: { outer: 14, inner: 8, stroke: 2 },
  md: { outer: 18, inner: 10, stroke: 2 },
  lg: { outer: 24, inner: 14, stroke: 3 },
};

export function EndpointStatusIndicator({ stats, size = "md" }: EndpointStatusIndicatorProps) {
  const { outer, inner, stroke } = sizeMap[size];
  const center = outer / 2;
  const outerRadius = (outer - stroke) / 2;
  const innerRadius = inner / 2;

  const { outerColor, innerColor, tooltip } = useMemo(() => {
    if (!stats || stats.computed.totalRequests === 0) {
      return {
        outerColor: getDormantColor(),
        innerColor: getDormantColor(),
        tooltip: "暂无数据",
      };
    }

    const { avgLatency, failureRate, totalRequests, failedRequests, healthScore, dormancyFactor } =
      stats.computed;

    const latencyColor = getLatencyColor(avgLatency, dormancyFactor);
    const failureColor = getFailureRateColor(failureRate, dormancyFactor);

    const latencyLabel =
      avgLatency < 1000 ? `${Math.round(avgLatency)}ms` : `${(avgLatency / 1000).toFixed(1)}s`;

    const successRate = 1 - failureRate;
    const successLabel = `${(successRate * 100).toFixed(0)}%`;

    const tooltipText = [
      `延迟: ${latencyLabel}`,
      `可用率: ${successLabel} (${totalRequests - failedRequests}/${totalRequests})`,
      `健康度: ${healthScore}`,
      dormancyFactor > 0.5 ? `(${Math.round(dormancyFactor * 100)}% 休眠)` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      outerColor: failureColor,
      innerColor: latencyColor,
      tooltip: tooltipText,
    };
  }, [stats]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <svg
            width={outer}
            height={outer}
            viewBox={`0 0 ${outer} ${outer}`}
            className="flex-shrink-0"
          >
            {/* 外圈 - 失败率 */}
            <circle
              cx={center}
              cy={center}
              r={outerRadius}
              fill="none"
              stroke={outerColor}
              strokeWidth={stroke}
              style={{ transition: "stroke 0.3s ease" }}
            />
            {/* 内圈 - 延迟 */}
            <circle
              cx={center}
              cy={center}
              r={innerRadius}
              fill={innerColor}
              style={{ transition: "fill 0.3s ease" }}
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs whitespace-pre-line">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
