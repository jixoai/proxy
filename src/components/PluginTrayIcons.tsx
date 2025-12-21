import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type TrayItem = {
  icon: string;
  description?: string;
};

function renderIcon(icon: string) {
  return <span className="text-base leading-none">{icon}</span>;
}

export function PluginTrayIcons({ items }: { items: TrayItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {items.map((item, index) => {
        if (item.description) {
          return (
            <Tooltip key={`${item.icon}-${index}`}>
              <TooltipTrigger asChild>
                <span className="flex items-center">{renderIcon(item.icon)}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <span className="text-xs leading-snug">{item.description}</span>
              </TooltipContent>
            </Tooltip>
          );
        }
        return (
          <span key={`${item.icon}-${index}`} className="flex items-center">
            {renderIcon(item.icon)}
          </span>
        );
      })}
    </div>
  );
}
