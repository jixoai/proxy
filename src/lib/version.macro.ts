/**
 * 编译时版本号宏
 * 在打包时会将版本号内嵌到代码中
 */
import packageJson from "../../package.json" with { type: "json" };

export function getPackageVersion(): string {
  return packageJson.version;
}
