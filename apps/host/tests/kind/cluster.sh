#!/usr/bin/env bash
# Needs kind v0.33.0, as CI pins it: v0.31 writes a kubeadm config the pinned v1.37 node refuses.
set -euo pipefail

out=${CLANKERBOX_KIND:-${TMPDIR:-/tmp}/clankerbox-kind}
cluster=clankerbox
node=kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5
version=v1.0.11
snapshotter=v8.7.0
hostpath=v1.19.0
namespace=clankerbox
context=kind-$cluster

mkdir -p "$out"

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --image "$node" --wait 120s
fi

# Every manifest is copied unchanged under vendor/, each from its repository at the version its
# directory names, so a run fetches no manifest. Images still come from their registries.
vendor="$(dirname "${BASH_SOURCE[0]}")/vendor"

# kind's own local-path provisioner takes no snapshots, so the cluster also runs the CSI host-path
# driver, whose class snapshots: https://github.com/kubernetes-csi/csi-driver-host-path
# The snapshot CRDs and controller are client/config/crd and deploy/kubernetes/snapshot-controller of
# https://github.com/kubernetes-csi/external-snapshotter.
kubectl --context "$context" apply -k "$vendor/external-snapshotter-$snapshotter/crd"
kubectl --context "$context" apply -k "$vendor/external-snapshotter-$snapshotter/snapshot-controller"
kubectl --context "$context" -n kube-system rollout status deploy/snapshot-controller --timeout=180s

# What the host-path driver's deploy/kubernetes-latest/deploy.sh applies by default, less the labels
# it adds to the RBAC, which nothing here reads: each sidecar's RBAC at the version of its image in
# csi-hostpath-plugin.yaml, then hostpath/*.yaml.
hostpaths="$vendor/csi-driver-host-path-$hostpath/hostpath"
image_tag() { sed -n "s|^ *image: .*/$1:||p" "$hostpaths/csi-hostpath-plugin.yaml"; }
for rbac in \
  "external-provisioner-$(image_tag csi-provisioner)/rbac.yaml" \
  "external-attacher-$(image_tag csi-attacher)/rbac.yaml" \
  "external-snapshotter-$(image_tag csi-snapshotter)/csi-snapshotter/rbac-csi-snapshotter.yaml" \
  "external-resizer-$(image_tag csi-resizer)/rbac.yaml"; do
  kubectl --context "$context" apply -f "$vendor/$rbac"
done
kubectl --context "$context" apply -f "$hostpaths"
driver=app.kubernetes.io/instance=hostpath.csi.k8s.io
sets=$(kubectl --context "$context" get statefulsets -l "$driver" -o name)
test -n "$sets"
for set in $sets; do
  kubectl --context "$context" rollout status "$set" --timeout=300s ||
    { kubectl --context "$context" describe pods -l "$driver"; exit 1; }
done

kubectl --context "$context" apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: csi-hostpath-sc}
provisioner: hostpath.csi.k8s.io
reclaimPolicy: Delete
volumeBindingMode: Immediate
allowVolumeExpansion: true
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-hostpath-snapclass
  annotations: {snapshot.storage.kubernetes.io/is-default-class: "true"}
deletionPolicy: Delete
driver: hostpath.csi.k8s.io
EOF
printf '%s' csi-hostpath-sc >"$out/storage-class"

# sandbox.yaml of https://github.com/kubernetes-sigs/agent-sandbox's release.
kubectl --context "$context" apply --server-side -f "$vendor/agent-sandbox-$version/sandbox.yaml"
kubectl --context "$context" -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s

kubectl --context "$context" apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata: {name: $namespace}
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: clankerbox-host, namespace: $namespace}
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: clankerbox-tester, namespace: $namespace}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: clankerbox-host, namespace: $namespace}
rules:
  - apiGroups: [agents.x-k8s.io]
    resources: [sandboxes]
    verbs: [get, list, create, patch, delete]
  - apiGroups: [""]
    resources: [persistentvolumeclaims]
    verbs: [get, list, create, patch, delete]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, create, delete]
  - apiGroups: [snapshot.storage.k8s.io]
    resources: [volumesnapshots]
    verbs: [get, list, create, delete]
  - apiGroups: [""]
    resources: [pods/exec, pods/portforward]
    verbs: [get, create]
  - apiGroups: [""]
    resources: [resourcequotas]
    verbs: [list]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: clankerbox-guests, namespace: $namespace}
spec:
  podSelector: {matchExpressions: [{key: cbx-host, operator: Exists}]}
  policyTypes: [Ingress, Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16]
    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
          podSelector: {matchLabels: {k8s-app: kube-dns}}
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: clankerbox-host, namespace: $namespace}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: clankerbox-host}
subjects: [{kind: ServiceAccount, name: clankerbox-host, namespace: $namespace}]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: clankerbox-tester, namespace: $namespace}
rules: [{apiGroups: ["*"], resources: ["*"], verbs: ["*"]}]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: clankerbox-tester, namespace: $namespace}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: clankerbox-tester}
subjects: [{kind: ServiceAccount, name: clankerbox-tester, namespace: $namespace}]
EOF

kubectl --context "$context" config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' >"$out/api"
kubectl --context "$context" config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' |
  base64 -d >"$out/ca.crt"
(umask 077 &&
  kubectl --context "$context" -n "$namespace" create token clankerbox-host --duration=24h >"$out/host-token" &&
  kubectl --context "$context" -n "$namespace" create token clankerbox-tester --duration=24h >"$out/tester-token")
printf '%s' "$namespace" >"$out/namespace"

export CLANKERBOX_KIND=$out
"$@"
