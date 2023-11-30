import chalk from 'chalk';
import fs from 'fs-extra';
import { isString } from 'narrowing';
import path from 'path';
import { PluginOption } from 'vite';
import { exec } from 'child_process';
//! TODO: Update package.json wasm-pack to 0.12.2 when it is released

/**
 *   return a Vite plugin for handling wasm-pack crate
 *   only use local crate
 *   import wasmPack from 'vite-plugin-wasm-pack';
 *   plugins: [wasmPack(['./my-local-crate'])]
 *   only use npm crate, leave the first param to an empty array
 *   plugins: [wasmPack([],['test-npm-crate'])]
 *   use both local and npm crate
 *   plugins: [wasmPack(['./my-local-crate'],['test-npm-crate'])]
 *
 * @param crates local crates paths, if you only use crates from npm, leave an empty array here.
 * @param moduleCrates crates names from npm
 */
function vitePluginWasmPack(crates: string[] | string): PluginOption {
  // Take a relative path to a crate and return the name of the crate
  function _crateName(cratePath: string) {
    return path.basename(path.resolve(cratePath));
  }

  function _runWasmPackBuild(
    cratePath: string,
    outDir: string = 'pkg'
  ): Promise<string> {
    const wasmPackPath = path.join(
      path.dirname(__dirname),
      'node_modules',
      '.bin',
      'wasm-pack'
    );

    const command: string = `${wasmPackPath} build --target web --out-dir ${outDir}`;

    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(`wasm-pack execution error: ${error}`);
          return;
        }
        resolve(stderr);
      });
    });
  }

  const prefix = '@wasm-pack@';
  const pkgDir = 'pkg'; // default folder of wasm-pack module
  let config_base: string;
  let config_assetsDir: string;
  const cratePaths: string[] = isString(crates) ? [crates] : crates;

  type CrateInfoType = { path: string; name: string };
  const wasmMap = new Map<string, CrateInfoType>();
  // Lookup wasm file name by crate path originally passed, in e.g. '../../my_crate' -> 'my_crate_bg.wasm'
  const cratePathLookup = new Map<string, string>();
  const crateNameLookup = new Map<string, string>();

  cratePaths.forEach((cratePath) => {
    const crateName = _crateName(cratePath);
    // from ../../my_crate  ->  my_crate_bg.wasm
    const wasmFile = crateName + '_bg.wasm';
    const localPath = path.resolve('node_modules', crateName, wasmFile);

    wasmMap.set(wasmFile, {
      path: localPath,
      name: crateName
    });
    cratePathLookup.set(cratePath, wasmFile);
    crateNameLookup.set(crateName, wasmFile);
  });

  return {
    name: 'vite-plugin-wasm-pack',
    enforce: 'pre',
    configResolved(resolvedConfig) {
      config_base = resolvedConfig.base;
      config_assetsDir = resolvedConfig.build.assetsDir;
    },

    resolveId(id: string) {
      if (crateNameLookup.has(id)) return prefix + id;
      return null;
    },

    async load(id: string) {
      if (id.indexOf(prefix) === 0) {
        id = id.replace(prefix, '');
        // Load the main .js file wasm-pack generates.
        const modulejs = path.join('./node_modules', id, id + '.js');
        const code = await fs.promises.readFile(modulejs, {
          encoding: 'utf-8'
        });
        return code;
      }
    },

    async buildStart(_inputOptions) {
      // For each crate, run wasm-pack and copy the pkg directory to node_modules
      const prepareBuild = async (cratePath: string) => {
        const crateName = _crateName(cratePath);
        const localPath = path.resolve('node_modules', crateName);

        try {
          const wasmPackOutput = await _runWasmPackBuild(cratePath, localPath);
          this.warn(
            chalk.bold(`wasm-pack: `) +
              `crate ${cratePath} built\n` +
              wasmPackOutput
          );

          // Read package.json and add 'type' field
          const pkgJsonPath = path.join(localPath, 'package.json');
          const pkgJson = await fs.readJson(pkgJsonPath);
          pkgJson.type = 'module';
          await fs.writeJson(pkgJsonPath, pkgJson);
        } catch (error) {
          this.error(
            chalk.bold(
              `vite-plugin-wasm-pack: Couldn't wasm-pack for Rust crate ${crateName}: \n`
            ) + error
          );
        }

        // TODO: is this necessary?
        // let jsPath = path.join('./node_modules', crateName, crateName + '.js');
        // const regex = /input = new URL\('(.+)'.+;/g;
        // let code = fs.readFileSync(path.resolve(jsPath), { encoding: 'utf-8' });
        // code = code.replace(regex, (_match, group1) => {
        //   return `input = "${path.posix.join(
        //     config_base,
        //     config_assetsDir,
        //     group1
        //   )}"`;
        // });
        // fs.writeFileSync(jsPath, code);
      };

      for await (const cratePath of cratePaths) {
        await prepareBuild(cratePath);
      }
    },

    configureServer({ middlewares }) {
      return () => {
        // send 'root/pkg/xxx.wasm' file to user
        middlewares.use((req, res, next) => {
          if (isString(req.url)) {
            const wasmFile = path.basename(req.url);
            const entry = wasmMap.get(wasmFile);

            if (entry && wasmFile.toLowerCase().endsWith('.wasm')) {
              res.setHeader(
                'Cache-Control',
                'no-cache, no-store, must-revalidate'
              );
              res.writeHead(200, { 'Content-Type': 'application/wasm' });
              fs.createReadStream(entry.path).pipe(res);
            } else {
              next();
            }
          }
        });
      };
    },

    buildEnd() {
      // copy xxx.wasm files to /assets/xxx.wasm
      wasmMap.forEach((crate, fileName) => {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${fileName}`,
          source: fs.readFileSync(crate.path)
        });
      });
    }
  };
}

export default vitePluginWasmPack;

// https://github.com/sveltejs/vite-plugin-svelte/issues/214
if (typeof module !== 'undefined') {
  module.exports = vitePluginWasmPack;
  vitePluginWasmPack.default = vitePluginWasmPack;
}

// moduleCrates?: string[] | string
// const modulePaths: string[] = !moduleCrates
//   ? []
//   : isString(moduleCrates)
//   ? [moduleCrates]
//   : moduleCrates;

// 'my_crate_bg.wasm': { path: 'node_modules/my_crate/my_crate_bg.wasm', isNodeModule: true }
// modulePaths.forEach((cratePath) => {
//   const wasmFile = wasmFilename(cratePath);
//   const wasmDirectory = path.dirname(require.resolve(cratePath));
//   wasmMap.set(wasmFile, {
//     path: path.join(wasmDirectory, wasmFile),
//     isNodeModule: true
//   });
// });

// const pkgPath = isNodeModule
// ? path.dirname(require.resolve(cratePath))
// : path.join(cratePath, pkg);

// if (isNodeModule) {
//   console.error(
//     chalk.bold.red('Error: ') +
//       `Can't find ${chalk.bold(pkgPath)}, run ${chalk.bold.red(
//         `npm install ${cratePath}`
//       )} first`
//   );
// } else {
// if (!isNodeModule) {
// copy pkg generated by wasm-pack to node_modules
// }
// replace default load path with '/assets/xxx.wasm'
// if (isNodeModule) {
//   jsPath = path.join(pkgPath, jsName);
// }

// for await (const cratePath of modulePaths) {
//   await prepareBuild(cratePath, true);
// }

/**
 * if use node module and name is '@group/test'
 * cratePath === '@group/test'
 * crateName === 'test'
 */
