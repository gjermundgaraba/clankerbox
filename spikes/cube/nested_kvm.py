#!/usr/bin/env python3
"""Execute MOV AX,42; HLT in a nested KVM vCPU. Only in the disposable VM."""
import ctypes
import fcntl
import json
import mmap
import os
import struct
import subprocess
from cube_spike import isolated, require


def probe():
    kvm = os.open("/dev/kvm", os.O_RDWR)
    vm = cpu = None
    try:
        require(fcntl.ioctl(kvm, 0xAE00, 0) == 12, 'KVM API version mismatch')
        vm = fcntl.ioctl(kvm, 0xAE01, 0)
        with mmap.mmap(-1, 2 * 1024 * 1024) as ram:
            ram[0x1000:0x1004] = b"\xb8\x2a\x00\xf4"
            address = ctypes.addressof(ctypes.c_char.from_buffer(ram))
            fcntl.ioctl(vm, 0x4020AE46, struct.pack("IIQQQ", 0, 0, 0, len(ram), address))
            cpu = fcntl.ioctl(vm, 0xAE41, 0)
            sregs = bytearray(312)
            fcntl.ioctl(cpu, 0x8138AE83, sregs)
            struct.pack_into("Q", sregs, 0, 0)  # CS base
            struct.pack_into("H", sregs, 12, 0)  # CS selector
            fcntl.ioctl(cpu, 0x4138AE84, sregs)
            regs = [0] * 18
            regs[16], regs[17] = 0x1000, 2
            fcntl.ioctl(cpu, 0x4090AE82, struct.pack("18Q", *regs))
            size = fcntl.ioctl(kvm, 0xAE04, 0)
            with mmap.mmap(cpu, size, flags=mmap.MAP_SHARED) as state:
                fcntl.ioctl(cpu, 0xAE80, 0)
                require(struct.unpack_from("I", state, 8)[0] == 5, "Expected KVM_EXIT_HLT")
            result = bytearray(144)
            fcntl.ioctl(cpu, 0x8090AE81, result)
            require(struct.unpack_from("Q", result)[0] == 42, 'Nested guest instruction returned wrong AX')
        return {"nested_kvm": "pass", "guest_instruction": "MOV AX,42; HLT", "rax": 42}
    finally:
        for fd in (cpu, vm, kvm):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    isolated()
    subprocess.run(['modprobe', 'kvm_amd'], check=True)
    print(json.dumps(probe()))
