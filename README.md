# Harper Deploy Action

Deploy a [Harper](https://github.com/HarperFast/harper) application from GitHub Actions, and give every pull request its own preview at `https://<branch>.app.<cluster-domain>/`.

The action authenticates with the job's [OIDC identity token](https://docs.github.com/en/actions/concepts/security/openid-connect) and nothing else. You store no username, password or token: the cluster trusts your workflow file, through a trust policy that a one-time setup command writes. The action talks only to your cluster and to GitHub.

## Deploy on merge

Run this once from a checkout of the repository, signed in to the cluster as a `super_user` (`harper login`). It creates a deploy role and user and the trust policy `github-actions-<app>`, and sets the `HARPER_CLI_TARGET` repository variable:

```bash
harper deploy setup=true provider=github-actions project=shop
```

Then commit `.github/workflows/deploy.yaml`, the file and the `production` environment that the policy pins:

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions: {}
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
    steps:
      - uses: HarperFast/deploy-action@v1
        with:
          target: ${{ vars.HARPER_CLI_TARGET }}
          app: shop
          by_ref: true
```

With `by_ref: true` the cluster fetches the commit itself, so the job needs no checkout. A private repository also needs `credential: true`, once `harper deploy setup=true` has sealed a credential.

An application that needs a build deploys a directory instead. Check out the code, build it, and name the output as `path`:

```yaml
steps:
  - uses: actions/checkout@v7
  - run: npm ci && npm run build
  - uses: HarperFast/deploy-action@v1
    with:
      target: ${{ vars.HARPER_CLI_TARGET }}
      app: shop
      path: dist
```

## Pull request previews

Previews need Harper 5.4 on the cluster.

Commit this as `.github/workflows/preview.yaml` on your default branch. GitHub runs `pull_request_target` workflows from there, so a PR cannot change what runs with the preview identity.

```yaml
name: Preview
on:
  pull_request_target:
    types: [opened, reopened, synchronize, closed]
    branches: [main]
permissions: {}
jobs:
  deploy:
    if: github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview
    permissions:
      id-token: write
      pull-requests: write
      deployments: write
    concurrency:
      group: harper-preview-${{ github.event.pull_request.number }}
    steps:
      - uses: HarperFast/deploy-action@v1
        with:
          target: ${{ vars.HARPER_PREVIEW_TARGET }}
          app: shop
          preview: true
  cleanup:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview-cleanup
    permissions:
      id-token: write
      pull-requests: write
      deployments: write
    steps:
      - uses: HarperFast/deploy-action@v1
        with:
          target: ${{ vars.HARPER_PREVIEW_TARGET }}
          app: shop
          preview: true
```

Then run setup once from a checkout that has that file, signed in as a `super_user`:

```bash
harper preview setup app=shop
```

Setup reads the workflow and refuses one that would give a fork or a PR's code the preview identity. It then enables previews on the cluster, which creates the role and user `<app>-ci-preview` and the trust policies `github-actions-<app>-preview` (environment `preview`) and `github-actions-<app>-preview-cleanup` (environment `preview-cleanup`, drop only). It also sets the `HARPER_PREVIEW_TARGET` repository variable. To remove it all, previews included, run `harper preview teardown app=shop`.

Some setup options have a matching input:

| `harper preview setup` | Action input                |
| ---------------------- | --------------------------- |
| `domain=<domain>`      | `domain: <domain>`          |
| `dataMode=shared`      | `branched_databases: false` |
| `credential=true`      | `credential: true`          |

A public repository also has to [allow `pull_request_target`](#allowing-pull_request_target).

### What each event does

| Event                                                  | What the action does                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opened`, `reopened`, `synchronize`                    | Deploys the PR's head commit by reference, only while the PR is open at that commit. Keeps one PR comment with the URL, updated in place, and a GitHub Deployment with `environment_url`. If the PR closed during the deploy, it drops what it deployed. |
| `closed`                                               | Drops the preview, marks its Deployments inactive and updates the comment. It retries for two minutes while a deploy still holds the preview, and a PR that was reopened keeps its preview.                                                              |
| `schedule`, `workflow_dispatch`                        | [Sweeps](#sweeping-missed-previews) the previews of closed PRs.                                                                                                                                                                                          |
| Anything from a fork, or another `pull_request` action | Nothing. The cluster is never called.                                                                                                                                                                                                                    |

The PR comment and the Deployment are best effort: if either fails, the run warns and the deploy still counts. Deployments use the GitHub environment `<app>-preview` (`deployment_environment`), kept apart from the `preview` environment that gates the job, so its required reviewers and its own deployment records stay out of it.

### Why two jobs

Required reviewers on the `preview` environment gate every deploy, which you want when previews share a cluster with production. They must not gate cleanup, or a closed PR's preview waits for an approval. So cleanup runs in `preview-cleanup`, which should have no required reviewers, under a policy that can only drop. It also stays out of the deploy's concurrency group, where a deploy waiting for approval would hold it up. A deploy that is still running when the PR closes drops its own preview when it finishes.

In **Settings > Environments**, allow your default branch under **Deployment branches and tags** on both environments.

### Sweeping missed previews

The cluster expires every preview on its own: seven days after its last deploy by default, or the application's `maxTtlDays`. That already covers a missed close event. A sweep removes those previews sooner.

The policies `harper preview setup` writes pin `event_name: pull_request_target`, so a scheduled run cannot use them, and a sweep also has to list what is deployed. It needs its own workflow file and its own trust policy.

Commit `.github/workflows/preview-sweep.yaml`:

```yaml
name: Preview sweep
on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:
permissions: {}
jobs:
  sweep:
    runs-on: ubuntu-latest
    environment: preview-cleanup
    permissions:
      id-token: write
      pull-requests: write
      deployments: write
    steps:
      - uses: HarperFast/deploy-action@v1
        with:
          target: ${{ vars.HARPER_PREVIEW_TARGET }}
          app: shop
          preview: true
```

Then add the policy as a `super_user`, with your repository's numeric id (`gh repo view --json databaseId`), name, branch and target:

```bash
harper add_oidc_trust id=github-actions-shop-preview-sweep \
  issuer=https://token.actions.githubusercontent.com \
  audience=https://cluster.example.com:9925/ \
  user=shop-ci-preview \
  'operations=["get_components","drop_component"]' \
  'claims={"repository_id":"123456789","workflow_ref":"acme/shop/.github/workflows/preview-sweep.yaml@refs/heads/main","event_name":["schedule","workflow_dispatch"],"environment":"preview-cleanup"}'
```

`harper preview teardown` does not know about this policy, so drop it yourself: `harper drop_oidc_trust id=github-actions-shop-preview-sweep`.

### Apps that need a build

The preview job must not build a PR: that would run the PR's code with the preview identity. Publish each PR commit from a separate, unprivileged `pull_request` workflow, then deploy the result from the preview job, with the package or by pointing `path` at a downloaded artifact:

```yaml
with:
  target: ${{ vars.HARPER_PREVIEW_TARGET }}
  app: shop
  preview: true
  args: package=npm:@acme/shop@pr-${{ github.event.pull_request.number }}
```

With a package the commit is still recorded on the preview. For a directory, also set `by_ref: false`.

## Allowing `pull_request_target`

GitHub's [workflow execution protections](https://docs.github.com/en/actions/concepts/about-actions-policies) add a default policy that blocks `pull_request_target` in public repositories that have no applicable event policy. It does not apply to private or internal repositories. GitHub first announced enforcement for November 2, 2026, and [moved it to December 2, 2026](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/). Once enforced, a blocked run fails with an error.

To keep previews working in a public repository, allow the event for this workflow:

1. Go to the repository's **Settings > Actions > Policies**, or the organization's, and create a policy.
2. Set its enforcement to active, and target `.github/workflows/preview.yaml`.
3. Add a **Restrict events** rule that allows `pull_request_target`.

**Policy insights**, under the same menu, shows which runs were or would have been blocked. An enterprise or organization policy can still block the event; see [Control workflow execution](https://docs.github.com/en/actions/how-tos/administer/control-workflow-execution).

## Inputs

| Input                    | Default              | Description                                                                                                             |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `target`                 | required             | The cluster's operations API URL. The trust policy's audience has to match it.                                          |
| `app`                    | required             | The application's component name.                                                                                       |
| `preview`                | `false`              | Run the preview lifecycle instead of a normal deploy.                                                                   |
| `path`                   | `.`                  | The directory to deploy as a payload, when not deploying by reference.                                                  |
| `by_ref`                 | see description      | Have the cluster fetch the commit. Defaults to `true` for previews and when `ref` is set, otherwise `false`.            |
| `ref`                    |                      | The commit, branch or tag to deploy by reference. Previews always deploy the PR's head commit.                          |
| `restart`                | `rolling`            | How a normal deploy restarts Harper, as the CLI's `restart=` argument.                                                  |
| `credential`             | `false`              | Use the sealed git credential to fetch a private repository.                                                            |
| `domain`                 | `app.<target host>`  | The preview domain.                                                                                                     |
| `label`                  |                      | A DNS label added to the preview host, to tell apart previews of several applications on one cluster.                   |
| `ttl`                    | the CLI's, 7 days    | Days until the cluster expires the preview, capped by the application's `maxTtlDays`.                                   |
| `branched_databases`     | `true`               | Give each preview its own database branch. `false` shares the cluster's data.                                           |
| `comment`                | `true`               | Keep one PR comment with the preview URL.                                                                               |
| `github_deployment`      | `true`               | Record each preview as a GitHub Deployment.                                                                             |
| `deployment_environment` | `<app>-preview`      | The GitHub environment for those Deployments.                                                                           |
| `args`                   |                      | More CLI arguments for the deploy, one `key=value` per line.                                                            |
| `harper_version`         | `>=5.4.0-alpha.1 <6` | The npm version or range of the `harper` CLI.                                                                           |
| `node_version`           | `24`                 | The Node.js version for the CLI, left on `PATH` for later steps. Empty uses the runner's, which must be 22.18 or later. |
| `github_token`           | `github.token`       | The token for PR comments and Deployments.                                                                              |

## Outputs

| Output    | Description                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outcome` | `deployed`, `dropped` (the PR is closed), `kept` (the PR reopened, so its preview stays), `swept`, or `skipped` (a fork, a superseded commit, or an action with nothing to do) |
| `url`     | The preview URL, when one deployed.                                                                                                                                            |

## Permissions

| Permission             | Needed for                                         |
| ---------------------- | -------------------------------------------------- |
| `id-token: write`      | Authenticating to the cluster. Always required.    |
| `pull-requests: write` | Reading the PR's state and keeping the PR comment. |
| `deployments: write`   | GitHub Deployments.                                |

Start from `permissions: {}` at the top of the workflow, as the examples do. A normal deploy needs only `id-token: write`, plus `contents: read` if it checks out a private repository.

## Security

- **The workflow is trusted, not the PR.** Preview jobs run from the default branch and never check out PR code, and the action refuses `preview: true` on `pull_request`. The trust policy pins the workflow file, the branch, `pull_request_target` and the environment.
- **Forks never get the identity.** The `if:` on each job is the gate: no token claim names the head repository. The action also skips a fork itself.
- **The PR's code still runs on the cluster**, with the preview role's rights. That role can deploy and drop only that application's `<app>-pr-<n>` previews. Without `branched_databases: false`, a preview's writes stay in its own database branch, except in the `system` database (users and roles), which cannot be branched.
- **A preview is the same site as what production serves from the cluster's host name.** Use `__Host-` cookie names and CSRF or `Origin` checks there.
- **OIDC only.** The CLI would prefer any other credential to the identity token. So the action strips `HARPER_CLI_*` and `CLI_TARGET_*` credentials from its environment and refuses them in `target` and `args`. It gives the CLI an empty home directory, where no `harper login` is saved, and refuses a deployed directory whose `.env` sets one. Preview runs start the CLI in an empty directory.
- **The CLI is installed fresh, into an empty directory, with install scripts off**, so a project's `.npmrc` has no say in it.

## Limitations

- Runs on Linux and macOS runners, not Windows.
- `.github/workflows/preview.yaml` is the workflow name the default policies pin. Another name needs `workflow=` on `harper preview setup`.
- Each application on a cluster needs its own preview slug: when two applications preview the same branch name, set `label` on one of them.

## License

[Apache-2.0](LICENSE)
