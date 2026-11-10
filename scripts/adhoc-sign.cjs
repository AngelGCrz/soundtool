// electron-builder afterPack: firma ad hoc todo el .app (sin certificado de Apple).
// Sin esto, en Macs con chip Apple la app descargada aparece como «dañada».
// Con firma ad hoc, macOS solo muestra el aviso de «desarrollador no identificado».
// Si algún día hay certificado Developer ID, se quita este paso y se configura mac.identity.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function (context) {
    if (context.electronPlatformName !== "darwin") return;
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
