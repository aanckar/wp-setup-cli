const fs = require("fs");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { prompt } = require("enquirer");
const Listr = require("listr");
const { NodeSSH } = require("node-ssh");
const Observable = require("zen-observable");
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

function getLinuxDir(dir) {
  return dir.replace(/\\/g, "/").replace("C:", "/mnt/c");
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
      type: "password",
      name: "password",
      message: "Enter SSH password",
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

  const { project } = response;

  const localDevDir = getLinuxDir(config.localDevDir);
  const localPluginDir = getLinuxDir(config.localPluginDir);
  const localProjectWwwDir = getLinuxDir(project.localWwwDir);

  const devProjects = ls(localDevDir);
  const localPlugins = ls(localPluginDir);

  const plugins = {
    dev: [],
    local: [],
    repo: [],
  };
  ls(path.join(localProjectWwwDir, "wp-content", "plugins")).forEach((item) => {
    if (devProjects.includes(item)) {
      plugins.dev.push(item);
    } else if (localPlugins.includes(item)) {
      plugins.local.push(item);
    } else {
      plugins.repo.push(item);
    }
  });

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
            password: response.password,
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
          `wp core install --url=${project.url} --title=${project.siteTitle} --admin_name=${config.wpUsername} --admin_password=${response.wpAdminPassword} --admin_email=${config.wpEmail}`
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
            const cmd = `rsync -chav ${localDevDir}/wordpress/plugins/${plugin}/* ${host}:${project.remoteWwwDir}/wp-content/plugins/${plugin}
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
            const cmd = `rsync -chav --filter=". rsync-filter.txt" ${localDevDir}/${plugin}/* ${host}:${project.remoteWwwDir}/wp-content/plugins/${plugin}
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
        const cmd = `rsync -chav --filter=". rsync-filter.txt" ${localDevDir}/${localTheme}/* ${host}:${project.remoteWwwDir}/wp-content/themes/${project.theme}
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
  process.exit();
}

try {
  run();
} catch (e) {
  console.error(e);
}
