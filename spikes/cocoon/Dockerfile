# Exact amd64 base includes kernel/initramfs/overlay hooks and cocoon-agent.
FROM ghcr.io/cocoonstack/cocoon/ubuntu@sha256:0a8de2c70f52f6241f9ad95affb302ef0ca7d36853e6d628ee9a91c5808e4152
ENV DEBIAN_FRONTEND=noninteractive
# Guest packages only. Freeze the resulting exported rootfs by SHA256 before boot.
RUN apt-get update && apt-get install -y --no-install-recommends python3 gcc libc6-dev docker.io linux-modules-extra-6.8.0-139-generic \
    && rm -rf /var/lib/apt/lists/* \
    && systemctl disable ssh.service ssh.socket docker.service docker.socket \
    && passwd -l root \
    && printf 'virtio_mmio\nvmgenid\n' >> /etc/initramfs-tools/modules \
    && printf 'RESUME=none\n' > /etc/initramfs-tools/conf.d/resume \
    && update-initramfs -u -k all \
    && mkdir -p /opt/clanker \
    && dpkg-query -W > /opt/clanker/packages.tsv
COPY guest.py guest_prepare.py probe.py /opt/clanker/
# Sentinel is started explicitly once by the harness, not on every boot.
CMD ["/sbin/init"]
