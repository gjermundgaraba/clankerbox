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

# kind's own local-path provisioner takes no snapshots, so the cluster also runs the CSI host-path
# driver, whose class snapshots: https://github.com/kubernetes-csi/csi-driver-host-path
# The snapshot CRDs and controller are client/config/crd and deploy/kubernetes/snapshot-controller of
# https://github.com/kubernetes-csi/external-snapshotter at $snapshotter, copied unchanged.
snapshots="$(dirname "${BASH_SOURCE[0]}")/external-snapshotter-$snapshotter"
kubectl --context "$context" apply -k "$snapshots/crd"
kubectl --context "$context" apply -k "$snapshots/snapshot-controller"
kubectl --context "$context" -n kube-system rollout status deploy/snapshot-controller --timeout=180s

if [ ! -d "$out/csi-driver-host-path" ]; then
  git clone -q --depth 1 -b "$hostpath" https://github.com/kubernetes-csi/csi-driver-host-path "$out/csi-driver-host-path"
fi
if ! kubectl --context "$context" get csidriver hostpath.csi.k8s.io >/dev/null 2>&1; then
  (kubectl config use-context "$context" >/dev/null &&
    "$out/csi-driver-host-path/deploy/kubernetes-latest/deploy.sh")
fi
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

kubectl --context "$context" apply --server-side -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$version/sandbox.yaml"
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
