import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { API_FORMAT_LABELS } from "@/lib/provider-routing-config";
import type { ProviderRoutingDraft } from "@/lib/provider-routing-form";
import type { ApiFormat } from "@/types/proxy";

function ApiFormatsInput({
  value,
  onChange,
  label,
}: {
  value: ApiFormat[];
  onChange: (value: ApiFormat[]) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map((format) => (
        <Button
          key={format}
          type="button"
          size="sm"
          variant={value.includes(format) ? "secondary" : "outline"}
          aria-pressed={value.includes(format)}
          onClick={() =>
            onChange(
              value.includes(format) ? value.filter((item) => item !== format) : [...value, format],
            )
          }
        >
          {API_FORMAT_LABELS[format]}
        </Button>
      ))}
    </div>
  );
}

export function ProviderRoutingInput({
  value,
  onChange,
  hasLegacyRewrite,
}: {
  value: ProviderRoutingDraft;
  onChange: (value: ProviderRoutingDraft) => void;
  hasLegacyRewrite: boolean;
}) {
  return (
    <section aria-label="模型与 API" className="space-y-5 border-t pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">模型与 API（可选）</h3>
        <p className="text-muted-foreground text-xs">
          不配置时：全部模型、API 不限制、模型原名透传。以下设置可独立使用。
        </p>
      </div>
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">支持的目标模型</legend>
        {!value.models.length && (
          <p className="text-muted-foreground text-xs">
            全部支持，无需列出所有模型。添加后仅允许列表中的目标模型。
          </p>
        )}
        {value.models.map((model, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label={`支持的目标模型 ${index + 1}`}
              value={model}
              placeholder="例如：glm-5.3-flash"
              onChange={(event) =>
                onChange({
                  ...value,
                  models: value.models.map((item, row) =>
                    row === index ? event.target.value : item,
                  ),
                })
              }
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`移除支持模型 ${index + 1}`}
              onClick={() =>
                onChange({ ...value, models: value.models.filter((_, row) => row !== index) })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ ...value, models: [...value.models, ""] })}
        >
          <Plus />
          添加支持模型
        </Button>
        {value.models.length > 0 && (
          <p className="text-muted-foreground text-xs">
            按映射后的目标名称匹配；清空列表会恢复全部支持。
          </p>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">模型名称映射</legend>
        <p className="text-muted-foreground text-xs">
          客户端名称 → 上游目标名称。未命中原名透传；只添加映射不会限制其他模型。
        </p>
        {value.mappings.map((mapping, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
              <Input
                aria-label={`客户端模型 ${index + 1}`}
                value={mapping.from}
                placeholder="客户端模型名"
                onChange={(event) =>
                  onChange({
                    ...value,
                    mappings: value.mappings.map((item, row) =>
                      row === index ? { ...item, from: event.target.value } : item,
                    ),
                  })
                }
              />
              <Input
                aria-label={`映射目标模型 ${index + 1}`}
                value={mapping.to}
                placeholder="上游目标模型名"
                onChange={(event) =>
                  onChange({
                    ...value,
                    mappings: value.mappings.map((item, row) =>
                      row === index ? { ...item, to: event.target.value } : item,
                    ),
                  })
                }
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`移除模型映射 ${index + 1}`}
              onClick={() =>
                onChange({ ...value, mappings: value.mappings.filter((_, row) => row !== index) })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({ ...value, mappings: [...value.mappings, { from: "", to: "" }] })
          }
        >
          <Plus />
          添加模型映射
        </Button>
        {hasLegacyRewrite && (
          <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
            检测到旧模型重写设置。新映射命中时优先于 x-target-model 和重写插件，建议清理重复配置。
          </p>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">Provider 支持的客户端 API</legend>
        <ApiFormatsInput
          label="Provider API 能力"
          value={value.apiFormats}
          onChange={(apiFormats) => onChange({ ...value, apiFormats })}
        />
        <p className="text-muted-foreground text-xs">
          {value.apiFormats.length ? "仅接收已选 API；全部取消则不限制。" : "未选择：API 不限制。"}{" "}
          包含现有插件转换后可接受的协议；此设置不会自动转换协议。
        </p>
      </fieldset>
      <details className="space-y-3" open={value.modelApis.length ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">按目标模型细分 API（可选）</summary>
        <p className="text-muted-foreground text-xs">
          与 Provider API 限制取交集。未配置或全部取消不增加限制，也不会将模型加入支持列表。
        </p>
        {value.modelApis.map((entry, index) => (
          <div key={index} className="space-y-2 border-b pb-3">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`API 限制目标模型 ${index + 1}`}
                value={entry.model}
                placeholder="上游目标模型名"
                onChange={(event) =>
                  onChange({
                    ...value,
                    modelApis: value.modelApis.map((item, row) =>
                      row === index ? { ...item, model: event.target.value } : item,
                    ),
                  })
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`移除模型 API 限制 ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...value,
                    modelApis: value.modelApis.filter((_, row) => row !== index),
                  })
                }
              >
                <Trash2 />
              </Button>
            </div>
            <ApiFormatsInput
              label={`模型 ${index + 1} API 能力`}
              value={entry.formats}
              onChange={(formats) =>
                onChange({
                  ...value,
                  modelApis: value.modelApis.map((item, row) =>
                    row === index ? { ...item, formats } : item,
                  ),
                })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({ ...value, modelApis: [...value.modelApis, { model: "", formats: [] }] })
          }
        >
          <Plus />
          添加模型 API 限制
        </Button>
      </details>
    </section>
  );
}
