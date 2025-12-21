import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PluginTrayIcons } from "@/components/PluginTrayIcons";
import { PluginUiMarkdown } from "@/components/PluginUiMarkdown";
import { buildPluginUiTooltipMarkdown, getTrayItems, type PluginUiRecord } from "@/lib/plugin-ui";

export function PluginUiBadge({ records }: { records: PluginUiRecord[] }) {
  if (records.length === 0) return null;

  const markdown = buildPluginUiTooltipMarkdown(records);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">生效了 {records.length} 个插件</span>
          <PluginTrayIcons items={getTrayItems(records)} />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap">
        <PluginUiMarkdown markdown={markdown} />
      </TooltipContent>
    </Tooltip>
  );
}
