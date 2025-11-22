import CONFIG_EXAMPLE from "../../config/proxy-config.example.json" with { type: "json" };

export function getConfigExample() {
  return JSON.stringify(CONFIG_EXAMPLE, null, 2);
}
