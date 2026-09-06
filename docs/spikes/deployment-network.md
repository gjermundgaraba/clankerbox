# Deployment and network investigation — 2026-09-04

Recommendation: deploy the Clankerbox controller on a dedicated Linux VM in
personal-cloud. Use a persistent WireGuard tunnel to the Hetzner host, carrying
only host control traffic and the approved workspace-backup flow. Keep guest
networking private/NAT; routed guest subnets are unnecessary for these needs.

This investigation inspected repository configuration and vendor documentation.
It did not provision a VM, configure a VPN, read credentials, or test live routes.

## Placement and repository ownership

The existing [`personal-cloud` architecture](../../../personal-cloud/ARCHITECTURE.md)
allows selected service VMs on `compute-node`. Reuse the Ubuntu cloud-image,
cloud-init, Ansible, systemd, and nftables patterns in
[`hosts/fugu-proxy`](../../../personal-cloud/hosts/fugu-proxy/README.md). Allocate a
free VMID, service IP, and DNS name after live inventory; do not copy Fugu's values.
The controller is trusted infrastructure and runs no coding-agent workloads.

Proposed ownership:

| Repository | Responsibility |
| --- | --- |
| `clankerbox` | API service, restricted host helper, native supervision templates, image recipes, profiles, lifecycle and recovery tests |
| `personal-cloud` | Controller VM, service deployment/version pins, host provisioning, VPN/firewall rules, credentials, backup accounts and monitoring |

Suggested deployment paths are `hosts/clankerbox-controller/`,
`deployments/clankerbox/`, and `backups/clankerbox/`. These are proposed new paths;
no personal-cloud files were changed during the spikes.

## Selective site-to-site connectivity

Use WireGuard between the home controller VM and the public Hetzner host. Home
can initiate to Hetzner with persistent keepalive, avoiding a home UDP port
forward. Choose a non-overlapping tunnel subnet after inventory. Configure
routes, forwarding and firewall rules deliberately: `AllowedIPs` alone is not a
complete firewall policy. [WireGuard quick start](https://www.wireguard.com/quickstart/).

| Flow | Proposed boundary |
| --- | --- |
| Controller → Hetzner control account | SSH over the tunnel, dedicated key restricted to the Clankerbox host helper |
| Controller → Mac control account | SSH over existing inter-VLAN network, exact source/destination allow |
| Linux guest → backup endpoint | Vetu NAT → Hetzner → tunnel → controller forwarding → storage-node TCP 8000 only |
| Mac guest → backup endpoint | Tart NAT → Mac source address → storage-node TCP 8000 only; verify effective source |
| User → Clankerbox | Existing private ingress/VPN, API authentication; SSH/VNC use authenticated per-machine streams |

The existing backup endpoint is `192.168.20.43:8000`. For Linux backup transit,
route only that `/32` through the tunnel; SNAT the permitted flow at the home VM
to its LAN address to avoid adding a return route on UniFi. Verify actual source
addresses and NAT behavior before installing final rules. The home VM becomes a
small, explicitly documented backup transit point. It must not forward general
LAN traffic. IPv6 and same-host guest access need equivalent restrictions.

For completeness, unmodified Orchard workers initiate their controller
connections outbound; they do not require an inbound worker listener. The
recommended direct-runtime design instead needs the explicit inbound SSH control
flow above. This is a deliberate architectural difference.

If VPN termination on the UDR7 is preferred, route-based IPsec to strongSwan on
Hetzner is a valid alternative. UniFi documents native third-party site-to-site
IPsec/OpenVPN separately from its WireGuard remote-access UI. That UI distinction
does not prevent routed site-to-site WireGuard on Linux. IPsec adds gateway policy
and interoperability configuration for this topology without being required by
the guests. [UniFi VPN types](https://help.ui.com/hc/en-us/articles/7951513517079-UniFi-Gateway-Introduction-to-VPNs),
[third-party IPsec](https://help.ui.com/hc/en-us/articles/7983431932439-UniFi-Gateway-Site-to-Site-IPsec-VPN-with-Third-Party-Gateways-Advanced).

## Backup and operations reuse

Reuse the TLS, append-only/private-repository rest-server pattern in
[`backups/agent-files`](../../../personal-cloud/backups/agent-files/README.md),
but provision new per-workspace repositories and credentials. Current inventory
is single-client and allows only two existing Mac VPN sources. Adding accounts,
capacity limits and the exact new source firewall rules is required; the live
endpoint is not already ready for arbitrary guests.

The existing `/rpool/backups/clients` tree is included in storage-node's offsite
backup sources. Verify the new repositories are captured and perform a restore;
do not infer end-to-end recovery from source-list membership.

Use personal-cloud's canonical 1Password Environment workflow for deployment
secrets and narrowly scoped unattended credentials. Do not reuse the existing
Mac backup passwords. Reuse Alloy/node-exporter/textfile metrics for host health,
disk capacity and backup freshness. No new monitoring stack is needed.

Before deployment, inventory the actual controller address, host SSH ports and
available capacity. Validate both allowed flows and denied host/LAN/Mgmt access
from disposable guests. Default NAT does not establish guest isolation.
