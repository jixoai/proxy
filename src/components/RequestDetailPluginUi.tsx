import type { PluginUiRecord } from "@/lib/plugin-ui";
import { PluginTrayIcons } from "@/components/PluginTrayIcons";
import { PluginUiMarkdown } from "@/components/PluginUiMarkdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildPluginUiTooltipMarkdown } from "@/lib/plugin-ui";

export function RequestDetailPluginUi({ records }: { records: PluginUiRecord[] }) {
  if (records.length === 0) return null;

  const markdown = buildPluginUiTooltipMarkdown(records);

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground text-sm font-medium">Plugin UI</div>
      <div className="flex flex-wrap items-center gap-3">
        {records.map((record) => (
          <div key={record.name} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{record.payload?.name ?? record.name}</span>
            <PluginTrayIcons items={record.payload?.tray ?? []} />
          </div>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground underline decoration-dashed underline-offset-4">
              查看备注
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap">
            <PluginUiMarkdown markdown={markdown} />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
