---
title: Docker Fundamentals
description: How containers actually isolate processes using Linux primitives, why images are layered, and the lifecycle details interviewers probe first
difficulty: Foundational
tags: [docker, containers, linux, networking]
---

Docker made containers usable, but the underlying mechanism is plain Linux — namespaces and cgroups, not magic. Interviewers use this topic to check whether you understand *what* is being isolated, because that understanding is what lets you debug a container in production instead of just running commands you memorised.

## Containers vs virtual machines

A VM virtualises hardware and runs a full guest kernel; a container shares the host kernel and isolates a *process*. That single fact explains almost every trade-off in the table below.

| Aspect | Virtual Machine | Container |
|---|---|---|
| Isolation unit | Full OS on virtual hardware | Process(es) on the host kernel |
| Boot time | Seconds to minutes | Milliseconds to ~1 second |
| Image size | GBs (full OS) | MBs to low hundreds of MBs |
| Kernel | Own kernel per VM | Shared host kernel |
| Density per host | Tens | Hundreds to thousands |
| Isolation strength | Strong (hardware-assisted) | Weaker (shared kernel attack surface) |
| Typical use | Mixed OS, strong tenant isolation | Packaging apps, microservices, CI |

```mermaid
flowchart TD
    subgraph "Virtual Machines"
    H1["Host OS + Hypervisor"] --> G1["Guest OS A"] --> A1["App A"]
    H1 --> G2["Guest OS B"] --> A2["App B"]
    end
    subgraph "Containers"
    H2["Host OS Kernel"] --> C1["Container A<br/>(namespaces + cgroups)"] --> A3["App A"]
    H2 --> C2["Container B<br/>(namespaces + cgroups)"] --> A4["App B"]
    end
```

> [!KEY]
> A container is a normal Linux process. `docker run` does not create a magical sandbox — it starts a process with a restricted view of the system, built from **namespaces** (what it can see) and **cgroups** (what it can use).

## The real mechanism: namespaces and cgroups

**Namespaces** partition kernel resources so a process believes it has the whole machine to itself:

| Namespace | Isolates |
|---|---|
| `pid` | Process IDs — container's PID 1 is a fresh tree |
| `net` | Network interfaces, routes, ports |
| `mnt` | Filesystem mount points |
| `uts` | Hostname and domain name |
| `ipc` | Shared memory, semaphores, message queues |
| `user` | UID/GID mapping (root in container ≠ root on host, if enabled) |

**cgroups** (control groups) do the opposite job: they **limit and account for** resources — CPU shares, memory ceilings, block I/O, and process counts — for a group of processes. A container being OOM-killed is a cgroup memory limit being enforced, not Docker "crashing".

```bash
# Prove it: a container's PID 1 has its own namespace, but the process
# is still visible from the host with a different PID
docker run -d --name web nginx
docker inspect -f '{{.State.Pid}}' web   # host-visible PID
docker exec web ps aux                   # inside: nginx is PID 1
```

Say it explicitly in an interview: "namespaces control visibility, cgroups control consumption." That one line signals you know Docker is a convenience layer over kernel features, not a new isolation technology.

## Images, containers and registries

An **image** is a read-only, layered filesystem plus metadata (entrypoint, env, exposed ports). A **container** is a running (or stopped) instance of an image with a thin writable layer on top. A **registry** (Docker Hub, GHCR, ACR, ECR) is where images are stored and versioned by name and tag.

```mermaid
flowchart LR
    R["Registry<br/>(e.g. ghcr.io)"] -- "docker pull" --> I["Image<br/>(read-only layers)"]
    I -- "docker run" --> C["Container<br/>(writable layer + process)"]
    C -- "docker commit / build" --> I2["New image layer"]
    I2 -- "docker push" --> R
```

## Layered filesystem and copy-on-write

Each Dockerfile instruction that changes the filesystem produces a new, immutable **layer**, identified by a content hash. Layers stack via a union filesystem (overlay2 on modern Linux). When a container writes to a file that exists in a lower layer, the file is copied up into the writable layer first — **copy-on-write (CoW)**. This is why layers are cached and shared across images: ten containers from the same image share the same read-only layers and only pay for their own small writable diffs.

This is *why* layer ordering in a Dockerfile matters for build speed — put rarely-changing instructions (installing dependencies) before frequently-changing ones (copying source code), so Docker can reuse cached layers.

## Tags, digests, and why `latest` is dangerous

A **tag** (`myapp:1.4.2`) is a mutable pointer that can be repointed to a different image at any time. A **digest** (`myapp@sha256:abcd…`) is an immutable, content-addressed reference — the same digest always resolves to the exact same bytes.

`latest` is just a tag like any other, with no special semantics enforced by Docker. It is dangerous because:

- It is mutable — "latest" today is not "latest" tomorrow, breaking reproducibility.
- It hides which version is actually running, making rollbacks and audits harder.
- Pulling `latest` in production can silently introduce breaking changes.

> [!DANGER]
> Never deploy `image:latest` in a production manifest. Pin an explicit version tag or, better, a digest (`image@sha256:...`) so the exact same artifact is guaranteed to run everywhere, every time.

## Container lifecycle

```bash
docker create myapp        # writable layer allocated, not started
docker start   <id>        # process launched
docker pause   <id>        # freeze processes (cgroup freezer)
docker stop    <id>        # SIGTERM, then SIGKILL after timeout (default 10s)
docker kill    <id>        # SIGKILL immediately
docker rm      <id>        # remove the stopped container's writable layer
```

| State | Meaning |
|---|---|
| Created | Filesystem prepared, not running |
| Running | PID 1 process active |
| Paused | Frozen via cgroup freezer, still resident |
| Exited | PID 1 terminated, layer still on disk |
| Removed | Writable layer deleted |

## PID 1 and signal handling

The process a container starts as PID 1 inherits special Linux behaviour: it does **not** get default signal handlers unless it explicitly registers them. Many apps ignore `SIGTERM` by default when running as PID 1, so `docker stop` sends `SIGTERM`, waits (default 10s), then sends `SIGKILL` — an ungraceful death that can corrupt in-flight work or drop connections.

> [!WARNING]
> If your entrypoint is a shell script that then `exec`s the real process, use `exec` explicitly (`exec myapp "$@"`). Without `exec`, the shell stays as PID 1 and swallows signals meant for your application, and `docker stop` will always time out into a hard kill.

Tools like `tini` or `dumb-init` (or Docker's own `--init` flag) solve this by acting as a minimal PID 1 that correctly forwards signals and reaps zombie processes.

## Networking basics: container vs host

By default, Docker creates containers on a **bridge network**, giving each container its own network namespace and a virtual interface (`veth`) paired to a bridge on the host. `--network host` removes that namespace entirely, so the container shares the host's IP and ports directly — faster (no NAT hop) but no port isolation, and unavailable on Docker Desktop for Mac/Windows in the same way as on Linux.

| Mode | Isolation | Typical use |
|---|---|---|
| `bridge` (default) | Own network namespace, NAT via host | Most local/dev workloads |
| `host` | Shares host network namespace | Latency-sensitive, single-tenant hosts |
| `none` | No networking at all | Batch jobs needing full isolation |

## Containers are not a security boundary

Because containers share the host kernel, a kernel-level exploit or a misconfigured `--privileged` flag can let a process escape the container entirely. Containers reduce blast radius and enforce discipline, but they are **not equivalent to a VM's hardware-enforced isolation**.

> [!DANGER]
> Never run containers with `--privileged` or as root inside the container unless you have a specific, understood reason. Combine namespaces/cgroups with seccomp profiles, read-only root filesystems, dropped Linux capabilities, and (where real multi-tenant isolation is required) a sandboxed runtime like gVisor or Kata Containers, or just use a VM boundary.

## Essential commands

| Command | Purpose |
|---|---|
| `docker build -t name:tag .` | Build an image from a Dockerfile |
| `docker run -d -p 8080:80 name` | Run detached, publish a port |
| `docker ps -a` | List containers, including stopped |
| `docker logs -f <id>` | Stream a container's stdout/stderr |
| `docker exec -it <id> sh` | Get an interactive shell inside a running container |
| `docker inspect <id>` | Full JSON metadata (namespaces, mounts, env) |
| `docker system prune -a` | Reclaim disk from unused images/containers/networks |
| `docker stats` | Live CPU/memory/IO per container |

## Cheat sheet

- Containers isolate a **process** via namespaces (visibility) and cgroups (limits); VMs virtualise **hardware**.
- Images are read-only layers; containers add a thin writable layer via copy-on-write.
- A tag is mutable, a digest is immutable — never ship `latest` to production.
- PID 1 needs explicit signal handling; use `exec` or an init like `tini` to avoid slow, ungraceful kills.
- `docker stop` = SIGTERM then SIGKILL after a grace period; `docker kill` = SIGKILL immediately.
- Default networking is `bridge` with NAT; `host` shares the host's network stack; `none` disables it.
- Containers are not a hard security boundary — never run `--privileged` without a specific reason.
- `docker system prune` and layer caching are your main tools for managing disk and build time.

## Common mistakes

| Mistake | Fix |
|---|---|
| Deploying `image:latest` | Pin a version tag or digest for reproducibility |
| Running the app as root inside the container | Add a `USER` instruction with a non-root UID |
| Shell-form entrypoint without `exec` | Use `exec "$@"` or an init process so signals reach PID 1 |
| Assuming containers are as isolated as VMs | Add seccomp/capabilities hardening; use a VM/sandbox runtime for real multi-tenancy |
| Treating `docker ps` (no `-a`) as the full picture | Stopped/exited containers still hold disk — use `-a` and prune regularly |
| Confusing image size on disk with layer count | Shared base layers are deduplicated; check with `docker history` |

## Summary

Docker containers are ordinary Linux processes made to feel isolated through namespaces (what they can see) and cgroups (what they can consume), which is why they start in milliseconds and share the host kernel — unlike VMs, which virtualise hardware and boot a separate kernel. Images are immutable, cached, content-addressed layers; containers are a writable layer plus a running process on top. Getting PID 1, signal handling, tagging discipline, and the "not a security boundary" nuance right is what separates someone who has *used* Docker from someone who understands it.

## Top Interview Questions

### Q1. What is the fundamental difference between a container and a virtual machine?

A VM virtualises hardware: each VM runs its own full guest kernel and OS on top of a hypervisor, giving strong, hardware-assisted isolation at the cost of size (GBs) and boot time (seconds to minutes). A container virtualises the operating system: it is a normal process on the host, isolated from other processes using Linux namespaces (for visibility — PIDs, network, mounts, hostname) and cgroups (for resource limits — CPU, memory, I/O). Because containers share the host kernel, they are far lighter (MBs, milliseconds to start) but offer weaker isolation — a kernel exploit can affect the whole host. In production, this trade-off usually favors containers for density and deployment speed, with VMs reserved for strong multi-tenant or mixed-OS isolation needs.

### Q2. Explain what namespaces and cgroups actually do, with an example of each.

Namespaces control what a process can **see**: a `pid` namespace gives a container its own process tree so its main process appears as PID 1, even though it has a different PID on the host; a `net` namespace gives it its own network interfaces and routing table. Cgroups control what a process can **use**: a memory cgroup enforces a hard ceiling, and when it is exceeded the kernel's OOM killer terminates a process in that group — this is what actually happens when you see `docker run` exit with code 137. Namespaces answer "what can I see", cgroups answer "how much can I use"; together they are the entire mechanism behind container isolation — Docker just orchestrates them.

### Q3. What is the difference between an image and a container?

An image is an immutable, read-only set of layered filesystem diffs plus metadata (default command, exposed ports, environment). A container is a runtime instance of an image: Docker adds a thin writable layer on top via copy-on-write and starts a process using that combined filesystem inside its own namespaces. You can create many containers from one image; each gets its own writable layer and process, but they all share the same underlying read-only image layers on disk, which is why running ten containers from one image doesn't use ten times the image's disk space.

### Q4. Why is `latest` considered dangerous in production, and what should you use instead?

`latest` is an ordinary, mutable tag with no enforced semantics — it is not guaranteed to be the newest or most stable build, just whatever was last pushed with that tag. Using it in a deployment manifest means the same manifest can pull different bytes at different times, breaking reproducibility, complicating rollbacks (you can't tell what version is currently running), and risking an unreviewed breaking change reaching production silently on a routine redeploy or node restart. The fix is to pin an explicit semantic version tag, and for maximum guarantees pin the image digest (`image@sha256:...`), which is content-addressed and immutable — the same digest always resolves to the exact same bytes regardless of what tags are later reassigned.

### Q5. What happens, in order, when you run `docker stop` on a container?

`docker stop` sends `SIGTERM` to the container's PID 1, then waits a grace period (default 10 seconds, configurable with `-t`), and if the process has not exited by then, sends `SIGKILL`, which terminates it immediately and cannot be caught or ignored. This matters because many application runtimes don't register a `SIGTERM` handler by default, or the process running as PID 1 is a shell wrapper that never forwards the signal to the real application — in both cases the container always falls through to the hard `SIGKILL` timeout, which can drop in-flight requests or corrupt state. The fix is to ensure the actual application process is PID 1 (via `exec` in shell entrypoints, or an init like `tini`) and that it handles `SIGTERM` by finishing in-flight work and exiting cleanly.

### Q6. Why does an ungraceful shell entrypoint break signal handling?

If a Dockerfile's `ENTRYPOINT` or `CMD` is written as `"start.sh"` and that script launches the real process without `exec` (e.g. `node server.js` instead of `exec node server.js`), the shell itself remains PID 1. Signals like `SIGTERM` are delivered to PID 1 — the shell — not automatically forwarded to its child, so the child never gets a chance to shut down gracefully, and `docker stop` reliably times out into `SIGKILL` on the whole process group. The fix is either `exec` at the end of the script so the real process replaces the shell as PID 1, or use `ENTRYPOINT ["node", "server.js"]` (exec form) directly, or wrap the entrypoint with `tini`/`--init` so signal forwarding and zombie reaping are handled correctly regardless of how the app is started.

### Q7. How would you debug a container that keeps getting OOM-killed?

First confirm it is actually OOM: `docker inspect` on the exited container shows an `OOMKilled: true` field and exit code 137. Then check the configured memory limit (`docker inspect` again, or the Kubernetes pod spec's `resources.limits.memory`) against actual usage with `docker stats` or a profiler inside the container before it dies. Common causes are an unbounded cache, a language runtime not respecting the container's cgroup limit (older JVMs before container-aware defaults, for example), or a genuine memory leak. The remediation is either to raise the limit if the workload legitimately needs more, tune the runtime to respect cgroup limits, or fix the leak — simply increasing the limit without diagnosing the cause just delays the failure.

### Q8. How does a layered image and a registry actually work together when you `docker pull`?

A registry stores images as a manifest (listing layer digests and config) plus the individual layer blobs, addressed by content hash. `docker pull` first fetches the manifest for the requested tag, resolves it to a set of layer digests, and then downloads only the layers not already present locally — this is why pulling a new version of an image you already have is usually fast, since most base layers are shared and already cached. Locally, the Docker engine assembles the layers with a union filesystem (overlay2) into a single coherent read-only filesystem, ready to have a writable layer added on top when a container is created from it.

### Q9. What's the difference between `docker run --network host` and the default bridge network?

The default `bridge` network gives each container its own network namespace with a virtual ethernet pair connecting it to a Linux bridge on the host; traffic in and out goes through NAT, and ports must be explicitly published with `-p` to be reachable from outside. `--network host` removes the network namespace boundary entirely — the container shares the host's network stack directly, so it can bind to any host port without publishing, has zero NAT overhead, but also has no port isolation between containers and cannot run two containers that bind the same port. Host networking is chosen for latency-sensitive workloads or tools needing raw access to host network interfaces; bridge is the safer default for most application workloads.

### Q10. Why are containers described as "not a security boundary" compared to VMs?

Because every container on a host shares the same kernel, a vulnerability in the kernel itself, a misconfigured `--privileged` flag, or excessive Linux capabilities can allow a process to escape its namespace/cgroup confinement and affect the host or other containers — something a VM's hardware-enforced isolation prevents by design. Containers reduce the practical attack surface and add strong operational discipline, but they were never designed as a hard multi-tenant security boundary. In production, this means never running containers as root or `--privileged` without a specific reason, applying seccomp and dropping unneeded capabilities, and reaching for a sandboxed runtime (gVisor, Kata Containers) or full VM isolation when running genuinely untrusted, multi-tenant workloads.

### Q11. What is copy-on-write and why does it make containers efficient?

Copy-on-write means that when a container writes to a file that exists in one of its read-only image layers, the filesystem first copies that file up into the container's own writable layer, then applies the write there — the underlying image layer is never modified. This lets many containers share the exact same read-only image layers on disk simultaneously, since none of them can mutate shared data; each container only consumes extra disk space proportional to what it actually changes. It is also why containers start so fast — there is no need to copy the entire image filesystem at container creation, only to prepare an empty writable layer and mount the shared read-only ones underneath it.

### Q12. How do you decide between publishing a port with `-p` and just using `EXPOSE` in the Dockerfile?

`EXPOSE` in a Dockerfile is purely documentation and metadata — it tells humans and orchestration tooling which ports the application listens on, but it does not, by itself, make the port reachable from outside the container or the host. `-p hostPort:containerPort` at `docker run` time (or the `ports:` section in Compose) is what actually creates the NAT rule/port mapping from the host into the container's network namespace. In practice you `EXPOSE` every port the app listens on as documentation, and then explicitly `-p` publish only the ones that actually need to be reachable from outside — for example not publishing an internal metrics port that only sibling containers on the same user-defined bridge network need to reach by container name.
