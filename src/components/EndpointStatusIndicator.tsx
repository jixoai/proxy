import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ForwardStats } from "@/hooks/useForwardStats";

interface EndpointStatusIndicatorProps {
  stats: ForwardStats | null;
  size?: "sm" | "md" | "lg";
}

/**
 * OKLCH 颜色插值
 * 关键点: 600ms 绿色, 4.5s 橙色, 10s 红色, 30s 深红色, 60s 黑色
 */
interface OklchColor {
  l: number; // 亮度 0-1
  c: number; // 色度 0-0.4
  h: number; // 色相 0-360
}

const latencyColorStops: Array<{ ms: number; color: OklchColor }> = [
  { ms: 0, color: { l: 0.72, c: 0.19, h: 145 } },      // 绿色
  { ms: 600, color: { l: 0.72, c: 0.19, h: 145 } },    // 绿色
  { ms: 4500, color: { l: 0.75, c: 0.18, h: 55 } },    // 橙色
  { ms: 10000, color: { l: 0.63, c: 0.26, h: 27 } },   // 红色
  { ms: 30000, color: { l: 0.45, c: 0.22, h: 25 } },   // 深红色
  { ms: 60000, color: { l: 0, c: 0, h: 0 } },          // 黑色
];

function lerpOklch(a: OklchColor, b: OklchColor, t: number): OklchColor {
  // 色相插值需要考虑环形特性
  let hDiff = b.h - a.h;
  if (Math.abs(hDiff) > 180) {
    hDiff = hDiff > 0 ? hDiff - 360 : hDiff + 360;
  }
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: (a.h + hDiff * t + 360) % 360,
  };
}

function oklchToString(color: OklchColor): string {
  return `oklch(${color.l} ${color.c} ${color.h})`;
}

function getLatencyColor(avgLatency: number, dormancyFactor: number): string {
  // 找到插值区间
  let lower = latencyColorStops[0]!;
  let upper = latencyColorStops[latencyColorStops.length - 1]!;

  for (let i = 0; i < latencyColorStops.length - 1; i++) {
    if (avgLatency >= latencyColorStops[i]!.ms && avgLatency <= latencyColorStops[i + 1]!.ms) {
      lower = latencyColorStops[i]!;
      upper = latencyColorStops[i + 1]!;
      break;
    }
  }

  // 超出范围时使用边界值
  if (avgLatency >= upper.ms) {
    lower = upper;
  }

  // 计算插值参数
  const range = upper.ms - lower.ms;
  const t = range > 0 ? (avgLatency - lower.ms) / range : 0;

  // OKLCH 插值
  const interpolated = lerpOklch(lower.color, upper.color, t);

  // 应用休眠因子 - 降低色度使颜色变灰
  const finalColor: OklchColor = {
    l: interpolated.l + (0.5 - interpolated.l) * dormancyFactor * 0.5,
    c: interpolated.c * (1 - dormancyFactor * 0.9),
    h: interpolated.h,
  };

  return oklchToString(finalColor);
}

/**
 * 计算失败率颜色 (OKLCH)
 * 关键点: 0% 绿色, 10% 绿色, 30% 橙色, 60% 红色, 100% 深红色
 */
const failureRateColorStops: Array<{ rate: number; color: OklchColor }> = [
  { rate: 0, color: { l: 0.72, c: 0.19, h: 145 } },    // 绿色
  { rate: 0.1, color: { l: 0.72, c: 0.19, h: 145 } },  // 绿色
  { rate: 0.3, color: { l: 0.75, c: 0.18, h: 55 } },   // 橙色
  { rate: 0.6, color: { l: 0.63, c: 0.26, h: 27 } },   // 红色
  { rate: 1, color: { l: 0.45, c: 0.22, h: 25 } },     // 深红色
];

function getFailureRateColor(failureRate: number, dormancyFactor: number): string {
  // 找到插值区间
  let lower = failureRateColorStops[0]!;
  let upper = failureRateColorStops[failureRateColorStops.length - 1]!;

  for (let i = 0; i < failureRateColorStops.length - 1; i++) {
    if (failureRate >= failureRateColorStops[i]!.rate && failureRate <= failureRateColorStops[i + 1]!.rate) {
      lower = failureRateColorStops[i]!;
      upper = failureRateColorStops[i + 1]!;
      break;
    }
  }

  // 超出范围时使用边界值
  if (failureRate >= upper.rate) {
    lower = upper;
  }

  // 计算插值参数
  const range = upper.rate - lower.rate;
  const t = range > 0 ? (failureRate - lower.rate) / range : 0;

  // OKLCH 插值
  const interpolated = lerpOklch(lower.color, upper.color, t);

  // 应用休眠因子 - 降低色度使颜色变灰
  const finalColor: OklchColor = {
    l: interpolated.l + (0.5 - interpolated.l) * dormancyFactor * 0.5,
    c: interpolated.c * (1 - dormancyFactor * 0.9),
    h: interpolated.h,
  };

  return oklchToString(finalColor);
}

/**
 * 获取休眠状态的灰色 (OKLCH)
 */
function getDormantColor(): string {
  return "oklch(0.7 0 0)";
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
