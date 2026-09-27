---
title: Docker Networking and Storage
description: How container networking modes and storage mounts actually behave in practice, and how to wire multiple services together with Compose
difficulty: Core
tags: [docker, networking, storage, docker-compose]
---

Most Docker interview failures aren't about syntax — they're about not knowing what happens to data when a container dies, or why two containers can't reach each other by name. This covers the networking drivers and storage mechanisms that make multi-container local development actually work.

## Network drivers

| Driver | Scope | Typical use |
|---|---|---|
| `bridge` (default) | Single host | Standard isolated networking for local containers |
| `host` | Single host | Shares host's network stack — no port isolation, no NAT overhead |
| `overlay` | Multi-host (Swarm/cluster) | Container-to-container networking across multiple hosts |
| `macvlan` | Single host, physical network | Assigns containers a real MAC/IP on the physical LAN |
| `none` | N/A | Full network isolation — no interfaces at all |

```mermaid
flowchart LR
    subgraph "Docker Host"
    C1["Container A"] -- "veth" --> B["docker0 bridge"]
    C2["Container B"] -- "veth" --> B
    B -- "NAT" --> E["Host eth0"]
    end
    E --> N["External Network"]
```

> [!KEY]
> The **default bridge** network (unnamed, created automatically) does **not** provide DNS-based service discovery between containers — only a **user-defined bridge network** does. This single fact explains most "why can't my containers talk to each other by name" interview questions.

## DNS and service discovery

On a user-defined bridge network, Docker runs an embedded DNS server that resolves container names (and Compose service names) to their current internal IP automatically.

```bash
docker network create app-net
docker run -d --name api  --network app-net myapi
docker run -d --name web  --network app-net myweb
# From inside `web`, http://api:8080 resolves via Docker's embedded DNS
```

On the legacy default `bridge` network, containers can only reach each other by IP (or via the deprecated `--link` flag), which is why the user-defined bridge is the recommended default for anything beyond a single container.

## Port publishing vs EXPOSE

`EXPOSE` in a Dockerfile is documentation only. `-p hostPort:containerPort` at `docker run` (or `ports:` in Compose) creates an actual iptables/NAT rule mapping a host port into the container's network namespace.

```bash
docker run -d -p 8080:80 nginx      # host:8080 -> container:80
docker run -d -p 127.0.0.1:8080:80 nginx  # bind only to localhost
docker run -d -P nginx              # publish all EXPOSEd ports to random host ports
```

Containers on the *same* user-defined network can always reach each other's ports directly by container name and container-internal port — they never need `-p` publishing for container-to-container traffic. `-p` is only for reachability from **outside** the Docker network (the host, or the internet).

## Storage: the writable layer

Every running container has a thin writable layer (via copy-on-write) for anything it writes at runtime. This layer is **tied to the container's lifecycle** — `docker rm` deletes it permanently, along with any data written there. This is the single most common cause of "I lost my data" incidents with databases run in plain containers.

## Volumes vs bind mounts vs tmpfs

| Type | Managed by | Location | Persists past container removal | Typical use |
|---|---|---|---|---|
| Named volume | Docker | Docker-managed area (e.g. `/var/lib/docker/volumes/...`) | ✅ | Databases, any data that must outlive the container |
| Bind mount | You (host path) | Any host path you specify | ✅ (it's just a host directory) | Local dev — live-editing source code, config files |
| `tmpfs` mount | Docker (in-memory) | RAM only, never touches disk | ❌ | Secrets, caches that must never persist to disk |

```bash
docker run -d -v pgdata:/var/lib/postgresql/data postgres        # named volume
docker run -d -v $(pwd)/src:/app/src myapp                        # bind mount
docker run -d --tmpfs /app/cache:size=64m myapp                   # tmpfs
```

> [!WARNING]
> A bind mount exposes the exact host path inside the container, including host-specific permission bits. If the host user's UID doesn't match the container process's UID, you get confusing "permission denied" errors on files that clearly exist — a very common local-dev support ticket. Match UIDs (`--user $(id -u):$(id -g)` on Linux) or adjust the container's user to resolve it.

## Data persistence and backup

Named volumes survive `docker rm` but not `docker volume rm`, and they are **not automatically backed up** by Docker. A backup strategy typically means running a short-lived container that mounts the volume read-only and streams its contents to a tarball or object storage.

```bash
docker run --rm -v pgdata:/data:ro -v $(pwd):/backup alpine \
  tar czf /backup/pgdata-backup.tar.gz -C /data .
```

## Permissions issues with mounted volumes

This is the single most common practical Docker/storage bug: a container process (often running as a specific non-root UID inside the image) tries to write to a bind-mounted directory owned by a different UID on the host, and the write fails silently or throws `EACCES`.

| Symptom | Cause | Fix |
|---|---|---|
| `permission denied` writing to a mounted volume | Container UID ≠ host directory owner UID | `chown` the host directory, or run container with matching `--user` |
| Files created by the container are unreadable on the host | Container wrote as root, host user has no permission | Avoid running as root; align UIDs |
| Works on Linux, fails differently on Docker Desktop (Mac/Windows) | Different filesystem translation layers for bind mounts | Test permission-sensitive workloads on the actual target OS |

## Docker Compose for local development

Compose describes a multi-container application declaratively — one file that replaces a series of manual `docker network create` / `docker run` commands, with dependency ordering and a shared network created automatically.

```yaml
# docker-compose.yml
version: "3.9"

services:
  api:
    build: ./api
    ports:
      - "8080:8080"
    environment:
      - ConnectionStrings__Default=Host=db;Database=app;Username=app;Password=app
    depends_on:
      db:
        condition: service_healthy
    networks:
      - app-net

  db:
    image: postgres:16
    environment:
      - POSTGRES_DB=app
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - app-net

volumes:
  pgdata:

networks:
  app-net:
```

`api` reaches the database at hostname `db` because Compose creates a user-defined bridge network and registers each service name in its embedded DNS automatically. `depends_on` with `condition: service_healthy` delays starting `api` until the database's `HEALTHCHECK` passes — plain `depends_on` without a condition only waits for the container to *start*, not for the service inside it to be *ready*.

> [!DANGER]
> A bare `depends_on: [db]` only guarantees start order, not readiness — a database container can report "started" long before Postgres is actually accepting connections. This is a classic source of flaky "works on retry" local dev and CI failures. Always pair `depends_on` with a `healthcheck` and `condition: service_healthy`, or add retry logic in the app.

## Resource limits

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M
        reservations:
          memory: 128M
```

Limits cap what a container **can** use (enforced via cgroups — exceeding the memory limit triggers an OOM kill); reservations are a soft guarantee used mainly by orchestrators for scheduling decisions, and have limited effect under plain `docker compose up` on a single host.

## Logging drivers

Docker containers write stdout/stderr, which the configured **logging driver** captures and routes.

| Driver | Behaviour |
|---|---|
| `json-file` (default) | Local JSON files on the host — simplest, no external dependency, can fill disk if unbounded |
| `local` | Similar to `json-file` but more efficient on-disk format with built-in rotation |
| `syslog` / `journald` | Forwards to the host's system logger |
| `awslogs` / `gcplogs` | Forwards directly to a cloud provider's log service |
| `none` | Discards output entirely |

> [!WARNING]
> The default `json-file` driver has **no log rotation by default** in older Docker versions — an unbounded, chatty container can fill the host's disk. Always set `max-size`/`max-file` options (or switch drivers) in production.

## Cheat sheet

- Only a **user-defined bridge** network gives you DNS-based service discovery by container/service name.
- `EXPOSE` documents; `-p` actually publishes a port to the outside world via NAT.
- Containers on the same network reach each other directly without `-p`.
- The writable layer dies with `docker rm` — anything that must persist needs a volume.
- Named volumes = Docker-managed, portable; bind mounts = host path, great for local dev; `tmpfs` = RAM-only, never persisted.
- UID mismatches between host and container are the #1 cause of mounted-volume permission errors.
- `depends_on` alone only waits for container start — pair it with `healthcheck` + `condition: service_healthy` for real readiness.
- Set resource `limits` to prevent one container from starving the host; `reservations` are best-effort outside a real orchestrator.
- Configure log rotation (`max-size`/`max-file`) — the default driver does not bound disk usage.

## Common mistakes

| Mistake | Fix |
|---|---|
| Expecting name resolution on the default bridge network | Create/use a user-defined bridge network |
| Confusing `EXPOSE` with actually publishing a port | Use `-p`/`ports:` to publish; `EXPOSE` is documentation only |
| Storing database data only in the container's writable layer | Mount a named volume for anything that must survive `docker rm` |
| `depends_on` without a health condition | Add a `healthcheck` and `condition: service_healthy` |
| Ignoring UID mismatches on bind mounts | Align UIDs or `chown` the host directory |
| No log rotation configured | Set `max-size`/`max-file` on the logging driver |
| Assuming `docker volume rm` is reversible | Back up volumes explicitly before destructive operations |

## Summary

Docker networking hinges on one distinction: the default bridge network gives you isolation but not name-based discovery, while a user-defined bridge (which Compose creates automatically) adds embedded DNS so services can reach each other by name. Storage hinges on another: a container's writable layer is ephemeral, so anything meant to outlive the container — databases, uploads, caches worth keeping — needs an explicit volume or bind mount, chosen based on whether Docker or you should own the data's location. Compose ties both together for local development, but its biggest trap is trusting `depends_on` for readiness rather than pairing it with an actual health check.

## Top Interview Questions

### Q1. Why can't two containers reach each other by name on the default bridge network, but they can on a user-defined one?

Docker's default (unnamed) bridge network was designed for backward compatibility and does not run the embedded DNS resolver that newer, user-defined bridge networks provide — on the default bridge, containers can only reach each other by IP address, and even that requires legacy `--link` flags for reliable resolution in older setups. A user-defined bridge network (created with `docker network create`, or automatically by Compose) registers every attached container's name in Docker's internal DNS server, so any container on that network can resolve another simply by its container or service name. The practical fix, and the recommended default in general, is to always create and use a user-defined network rather than relying on the default bridge.

### Q2. What is the difference between `EXPOSE` in a Dockerfile and `-p` at `docker run`?

`EXPOSE` is purely declarative metadata baked into the image, documenting which ports the containerized application listens on; it has no effect on networking behavior by itself and does not make a port reachable from outside the container. `-p hostPort:containerPort` (or `ports:` in Compose) is what actually creates a NAT/port-forwarding rule from a port on the host into the container's network namespace, making the service reachable from outside the Docker network. A common confusion is assuming `EXPOSE` alone is sufficient for external access — containers on the *same* Docker network can already reach each other's ports without any publishing at all; `-p` is specifically for reachability from the host or the outside world.

### Q3. What happens to data written inside a container if you don't use a volume, and why does this matter for databases?

Anything a container writes to its filesystem at runtime lands in its thin writable layer, created via copy-on-write on top of the image's read-only layers. That writable layer is tied to the container's lifecycle — stopping the container leaves it intact, but `docker rm` permanently deletes it along with everything written there. For a database container, this means that without an explicitly mounted volume, all data is lost the moment the container is removed (which happens routinely during upgrades, redeploys, or `docker compose down`) — a very common and very costly production mistake. The fix is to always mount a named volume (or bind mount) at the database's data directory so the data's lifecycle is decoupled from the container's.

### Q4. When would you choose a named volume over a bind mount?

A named volume is created and managed entirely by Docker, stored in a Docker-controlled location on the host, and is the right choice for data that the application owns and that should persist independent of any particular host path — database files, message queue state, anything you don't need to inspect or edit directly from the host. A bind mount maps a specific host directory into the container and is the right choice when you need direct, two-way visibility into the files — most commonly, live-editing source code during local development so changes are reflected in the running container without a rebuild, or mounting host configuration files. In production, named volumes are generally preferred because they're portable across hosts (with the right volume driver) and don't depend on a specific host directory structure existing.

### Q5. A container can't write to a directory you bind-mounted from the host — how do you diagnose and fix it?

This is almost always a UID/GID mismatch: the process inside the container runs as some UID (often a non-root UID set via `USER` in the Dockerfile), and the host directory is owned by a different UID, so the Linux permission check inside the shared filesystem fails regardless of what looks right from either side alone. Diagnose by checking the container's effective user (`docker exec <id> id`) against the host directory's owner (`ls -ln` on the host, comparing numeric UIDs, not names, since names don't map across the host/container boundary). Fix it either by `chown`-ing the host directory to match the container's UID, running the container with `--user $(id -u):$(id -g)` so it matches the host user, or adjusting the Dockerfile to create its non-root user with a UID chosen to match the host's expected owner.

### Q6. Why is `depends_on` in Compose often not enough to guarantee a service starts successfully?

Plain `depends_on: [db]` only controls **container start order** — Compose starts `db` and waits for its process to begin running, then starts `api` — but a database process reporting "started" is not the same as it being ready to accept connections; Postgres, for example, can take a noticeable moment after its process starts before it's actually listening and initialized. If `api` attempts to connect immediately at startup, it can fail intermittently depending on timing, producing flaky "works on the second try" behavior in local dev and CI. The fix is to add a `healthcheck` to the dependency service (e.g., `pg_isready` for Postgres) and use `depends_on: db: condition: service_healthy`, which delays starting the dependent service until the health check actually passes, or to add connection retry logic in the application itself as defense in depth.

### Q7. What's the difference between a resource `limit` and a `reservation` in Compose/Docker, and does the reservation actually do anything on a single host?

A `limit` (`cpus`, `memory`) is a hard ceiling enforced by the Linux cgroup subsystem — exceeding the memory limit triggers an OOM kill of a process in that container, and exceeding the CPU limit throttles it. A `reservation` is a soft target primarily used by cluster schedulers (Swarm, Kubernetes-equivalent concepts) to decide which host has enough spare capacity to place a workload; on a single Docker host running `docker compose up` without Swarm, reservations have little to no enforced effect because there's no scheduler making a placement decision — only the `limits` are meaningfully enforced. This distinction matters in interviews because candidates often assume reservations guarantee resources are set aside, when in plain Docker they're closer to documentation/scheduling hints.

### Q8. How would you back up data stored in a Docker named volume?

Since a named volume isn't automatically backed up and its host-side location shouldn't be relied upon directly (it can vary by driver and Docker version), the standard approach is to run a short-lived utility container that mounts the volume (read-only, if possible, to avoid interfering with a running writer) alongside a host directory or object storage mount, and archive its contents — for example `docker run --rm -v pgdata:/data:ro -v $(pwd):/backup alpine tar czf /backup/pgdata.tar.gz -C /data .`. For a live database, this file-level approach can capture an inconsistent snapshot if writes are in-flight, so production backups usually prefer the database's own logical backup tool (`pg_dump`, `mysqldump`) run against the running service, with the volume-level tar approach reserved for simpler, less write-heavy data.

### Q9. What logging driver does Docker use by default, and what problem can it cause in production if left unconfigured?

The default logging driver is `json-file`, which writes each container's stdout/stderr as JSON-encoded lines to a file on the host, readable via `docker logs`. Without explicitly configured rotation options (`max-size`, `max-file`), a chatty container's logs can grow unbounded and eventually fill the host's disk, which can then cascade into failures for every other container on that host — a real production incident pattern, not a theoretical one. The fix is to always set `--log-opt max-size=10m --log-opt max-file=3` (or the Compose `logging:` equivalent), or route logs to a driver/aggregator (syslog, a cloud provider's log service, or a sidecar shipping to something like Loki/ELK) designed for retention and rotation from the start.

### Q10. What's the difference between the `host` and `bridge` network drivers, and when would you actually reach for `host`?

`bridge` (the default) gives a container its own network namespace, connected to a virtual bridge on the host via a veth pair, with traffic NAT'd in and out — ports must be explicitly published to be reachable externally, but this also means multiple containers can bind the same internal port without conflict. `host` removes the network namespace boundary entirely, so the container shares the host's actual network stack — no NAT overhead (useful for latency-sensitive workloads or high packet-rate services), but the container can now bind to any host port directly and two containers cannot both bind the same port. You'd reach for `host` for performance-critical networking tools, or software that needs to observe host-level network traffic, not for typical application containers where the isolation of `bridge` is a feature, not overhead worth removing.

### Q11. In the example Compose file with an `api` and a `db` service, why does `api` connect to `db` using the hostname `db` rather than an IP address, and what would break if you removed the shared `networks:` block?

Compose automatically creates a user-defined bridge network for the project and attaches every service to it by default, registering each service's name in Docker's embedded DNS server — so `api`'s connection string can reference `db` as a hostname, and it resolves to whatever internal IP the `db` container currently has, which is exactly what allows the database container to be recreated (getting a new internal IP) without ever needing to update `api`'s configuration. If you removed the shared network (or put the services on different explicit networks without connecting both), DNS resolution would fail because the two containers would no longer share a network namespace-reachable bridge, and `api` would get a connection error trying to resolve or reach `db` at all — this is a common debugging scenario when someone introduces an additional `networks:` block per service without realizing it isolates them from each other.
