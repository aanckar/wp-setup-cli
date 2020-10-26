const fs = require("fs");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { prompt } = require("enquirer");
const Listr = require("listr");
const { NodeSSH } = require("node-ssh");
const Observable = require("zen-observable");
const terminalLink = require("terminal-link");
const config = require("./config.json");

function ls(basedir) {
  return fs
    .readdirSync(basedir, { withFileTypes: true })
    .filter((item) => item.isDirectory() || item.isSymbolicLink())
    .map((item) => item.name);
}

async function localExec(cmd) {
  try {
    const { stderr } = await exec(cmd);
    if (stderr) {
      console.error(stderr);
    }
  } catch (e) {
    console.error(e);
  }
}

async function run() {
  const response = await prompt([
    {
      type: "select",
      name: "project",
      message: "Select project",
      choices: config.projects.map((item) => ({
        name: item.name,
        value: item,
      })),
      result(item) {
        return Object.values(this.map(item))[0];
      },
    },
    {
      type: "input",
      name: "dbName",
      message: "Enter DB name (& user)",
    },
    {
      type: "password",
      name: "dbPassword",
      message: "Enter DB password",
    },
    {
      type: "password",
      name: "wpAdminPassword",
      message: "Enter WP admin password",
    },
  ]).catch(console.error);

  if (!response) {
    return;
  }

  const { project } = response;

  const devDirs = ls(config.devDir);
  const localPlugins = ls(config.pluginDir);

  const plugins = {
    dev: [],
    local: [],
    repo: [],
  };
  ls(path.join(project.localWwwDir, "wp-content", "plugins")).forEach(
    (item) => {
      if (devDirs.includes(item)) {
        plugins.dev.push(item);
      } else if (localPlugins.includes(item)) {
        plugins.local.push(item);
      } else {
        plugins.repo.push(item);
      }
    }
  );

  const ssh = new NodeSSH();
  async function remoteExec(cmd) {
    try {
      await ssh.execCommand(cmd, {
        cwd: project.remoteWwwDir,
      });
    } catch (e) {
      console.error(e);
    }
  }

  const host = `${project.username}@${project.host}`;
  const tasks = new Listr([
    {
      title: "Connect to server",
      task: async () => {
        try {
          await ssh.connect({
            host: project.host,
            username: project.username,
            privateKey: `${require("os").homedir()}/.ssh/id_rsa`,
          });
        } catch (e) {
          console.error(e);
        }
      },
    },
    {
      title: "Download WP",
      task: async () => {
        await remoteExec("wp core download --locale=fi");
      },
    },
    {
      title: "Install WP",
      task: async () => {
        await remoteExec(
          `wp core config --dbname=${response.dbName} --dbuser=${
            response.dbName
          } --dbpass=${response.dbPassword} ${
            project.host.includes("www36")
              ? "--dbhost=localhost:/usr/local/mysql/data/mysql.sock"
              : ""
          }`
        );
        await remoteExec(
          `wp core install --url=${project.siteUrl} --title=${project.siteTitle} --admin_name=${config.wpUsername} --admin_password=${response.wpAdminPassword} --admin_email=${config.wpEmail}`
        );
        await remoteExec("rm -rf index.html cgi-bin");
      },
    },
    {
      title: "Uninstall default plugins & themes",
      task: async () => {
        await remoteExec("wp plugin uninstall hello akismet");
        await remoteExec("wp theme delete twentyseventeen twentynineteen");
      },
    },
    {
      title: "Install plugins",
      task: async () => {
        await remoteExec(
          `wp plugin install ${plugins.repo.join(" ")} --activate`
        );
      },
    },
    {
      title: "Copy premium plugins",
      skip: () => !plugins?.local?.length,
      task: () =>
        new Observable(async (observer) => {
          for (let plugin of plugins.local) {
            observer.next(plugin);
            const cmd = `rsync -chav ${config.devDir}/wordpress/plugins/${plugin}/* ${host}:${project.remoteWwwDir}/wp-content/plugins/${plugin}
            `;
            try {
              await localExec(cmd);
            } catch (e) {
              console.error(e);
            }
          }
          observer.next("Activate plugins");
          await remoteExec(`wp plugin activate ${plugins.local.join(" ")}`);
          observer.complete();
        }),
    },
    {
      title: "Copy dev plugins",
      skip: () => !plugins?.dev?.length,
      task: () =>
        new Observable(async (observer) => {
          for (let plugin of plugins.dev) {
            observer.next(plugin);
            const cmd = `rsync -chav --filter=". rsync-filter.txt" ${config.devDir}/${plugin}/* ${host}:${project.remoteWwwDir}/wp-content/plugins/${plugin}
            `;
            try {
              await localExec(cmd);
            } catch (e) {
              console.error(e);
            }
          }
          observer.next("Activate plugins");
          await remoteExec(`wp plugin activate ${plugins.dev.join(" ")}`);
          observer.complete();
        }),
    },
    {
      title: "Copy theme",
      task: async () => {
        const localTheme = project?.localTheme || `${project.theme}-theme`;
        const cmd = `rsync -chav --filter=". rsync-filter.txt" ${config.devDir}/${localTheme}/* ${host}:${project.remoteWwwDir}/wp-content/themes/${project.theme}
        `;
        try {
          await localExec(cmd);
          await remoteExec(`wp theme activate ${project.theme}`);
        } catch (e) {
          console.error(e);
        }
      },
    },
  ]);

  await tasks.run().catch((err) => {
    console.error(err);
  });
  const link = terminalLink("Site is live", `https://${project.siteUrl}`);
  console.log("All done");
  console.log(link);
  process.exit();
}

try {
  run();
} catch (e) {
  console.error(e);
}
