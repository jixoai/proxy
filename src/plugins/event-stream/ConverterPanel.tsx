import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Layers3, Plus, Trash2, ArrowUp, ArrowDown, Pencil, Eye, EyeOff } from "lucide-react";
import type { BuiltInConverterId, ConverterInstance, StepVisibilityMap } from "./types";

interface ConverterPanelProps {
  converters: ConverterInstance[];
  visibility: StepVisibilityMap;
  pickerOpen: boolean;
  onPickerOpenChange(open: boolean): void;
  onAddBuiltIn(id: BuiltInConverterId): void;
  onAddExpression(): void;
  onAddFunction(): void;
  onMove(id: string, direction: -1 | 1): void;
  onEdit(instance: ConverterInstance): void;
  onRemove(id: string): void;
  onToggleVisibility(id: string): void;
}

export function ConverterPanel({
  converters,
  visibility,
  pickerOpen,
  onPickerOpenChange,
  onAddBuiltIn,
  onAddExpression,
  onAddFunction,
  onMove,
  onEdit,
  onRemove,
  onToggleVisibility,
}: ConverterPanelProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers3 className="text-muted-foreground size-4" />
          <span className="text-sm font-semibold">转换管线</span>
        </div>
        <div>
          <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8">
                <Plus className="mr-1 size-4" /> 添加转换器
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0">
              <Command>
                <CommandInput placeholder="搜索转换器" />
                <CommandList>
                  <CommandEmpty>没有匹配的转换器</CommandEmpty>
                  <CommandGroup heading="内置">
                    <CommandItem onSelect={() => onAddBuiltIn("auto")}>
                      Auto（Base64 → JSON）
                    </CommandItem>
                    <CommandItem onSelect={() => onAddBuiltIn("base64")}>Base64 解码</CommandItem>
                    <CommandItem onSelect={() => onAddBuiltIn("json")}>JSON 格式化</CommandItem>
                  </CommandGroup>
                  <CommandGroup heading="自定义">
                    <CommandItem
                      onSelect={() => {
                        onPickerOpenChange(false);
                        onAddExpression();
                      }}
                    >
                      JS 表达式
                    </CommandItem>
                    <CommandItem
                      onSelect={() => {
                        onPickerOpenChange(false);
                        onAddFunction();
                      }}
                    >
                      完整 JS 函数
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="divide-y rounded border">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex-1">
            <p className="text-sm font-medium">原始数据</p>
            <p className="text-muted-foreground text-xs">message data 初始内容</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onToggleVisibility("raw")}
            >
              {visibility.raw === false ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
        {converters.length === 0 && (
          <div className="text-muted-foreground py-3 text-center text-xs">
            未添加转换器，直接使用原始数据
          </div>
        )}
        {converters.map((converter, index) => (
          <div key={converter.instanceId} className="flex items-center gap-3 px-3 py-2">
            <div className="flex-1">
              <p className="text-sm font-medium">
                {converter.kind === "builtin"
                  ? converter.converterId.toUpperCase()
                  : converter.name}
              </p>
              <p className="text-muted-foreground text-xs">
                {converter.kind === "builtin" ? `内置 ${converter.converterId}` : "自定义转换器"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onToggleVisibility(converter.instanceId)}
                title={visibility[converter.instanceId] === false ? "显示此步骤" : "隐藏此步骤"}
              >
                {visibility[converter.instanceId] === false ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={index === 0}
                onClick={() => onMove(converter.instanceId, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={index === converters.length - 1}
                onClick={() => onMove(converter.instanceId, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              {converter.kind !== "builtin" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onEdit(converter)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive h-7 w-7"
                onClick={() => onRemove(converter.instanceId)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
