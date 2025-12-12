import { ProxyControl } from "@/components/ProxyControl";

export function ControlPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl">
          <h1 className="mb-6 text-2xl font-semibold">内核控制</h1>
          <ProxyControl />
        </div>
      </div>
    </div>
  );
}
