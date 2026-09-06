#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* Intentionally self-contained: builds as a static Linux binary with musl. */
#define MIB UINT64_C(1048576)
#define PAGE 4096U
#define RING 4096U
#define RECENT 64U
#define REQUEST_MAX 256U
#define MARKER_BYTES 128U
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static unsigned char *ram;
static size_t ram_size;
static uint64_t memory_mib = 128, workspace_mib, workspace_files = 1024, dirty_mib_s;
static const char *socket_path = "/tmp/clanker-latency.sock";
static const char *workspace = "/tmp/clanker-latency-workspace";
static uint64_t ram_marker, started_ns, dirty_bytes, dirty_passes;
static unsigned branch;
static bool paused, dirty_busy;
static bool reuse_workspace;
static uint64_t mono_ring[RING], raw_ring[RING], sample_count, max_mono, max_raw;
static uint64_t last_mono, last_raw;

static void die(const char *s) { perror(s); exit(1); }
static uint64_t stamp(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t)) die("clock_gettime");
    return (uint64_t)t.tv_sec * 1000000000ULL + (uint64_t)t.tv_nsec;
}
static uint64_t mono(void) { return stamp(CLOCK_MONOTONIC); }
static uint64_t raw(void) {
#ifdef CLOCK_MONOTONIC_RAW
    return stamp(CLOCK_MONOTONIC_RAW);
#else
    return mono();
#endif
}
static void nap(long ns) {
    struct timespec t = {ns / 1000000000L, ns % 1000000000L};
    while (nanosleep(&t, &t) && errno == EINTR) {}
}
static uint64_t mix(uint64_t x) {
    x += UINT64_C(0x9e3779b97f4a7c15);
    x = (x ^ (x >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)) * UINT64_C(0x94d049bb133111eb);
    return x ^ (x >> 31);
}
static void write_all(int fd, const void *data, size_t n) {
    const unsigned char *p = data;
    while (n) {
        ssize_t k = write(fd, p, n);
        if (k < 0 && errno == EINTR) continue;
        if (k <= 0) die("write");
        p += k; n -= (size_t)k;
    }
}
static void path(char out[PATH_MAX], const char *leaf) {
    int n = snprintf(out, PATH_MAX, "%s/%s", workspace, leaf);
    if (n < 0 || n >= PATH_MAX) { errno = ENAMETOOLONG; die("workspace path"); }
}
static int disk_branch(unsigned *value) {
    char name[PATH_MAX], data[MARKER_BYTES + 1];
    path(name, "branch-marker");
    int fd = open(name, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size != MARKER_BYTES) { close(fd); return 0; }
    size_t count = 0;
    while (count < MARKER_BYTES) {
        ssize_t n = read(fd, data + count, MARKER_BYTES - count);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(fd); return 0; }
        count += (size_t)n;
    }
    close(fd);
    if (memchr(data, 0, MARKER_BYTES) || data[MARKER_BYTES - 1] != '\n') return 0;
    data[MARKER_BYTES] = 0;
    uint64_t bytes, files; char trailing;
    return sscanf(data, "clanker-latency-v2 %" SCNu64 " %" SCNu64 " %u %c", &bytes, &files, value, &trailing) == 3
        && bytes == workspace_mib * MIB && files == workspace_files && *value <= INT_MAX;
}
static void save_branch(bool create) {
    char name[PATH_MAX], data[MARKER_BYTES];
    path(name, "branch-marker");
    int flags = O_WRONLY | O_NOFOLLOW | (create ? O_CREAT | O_EXCL : 0);
    int fd = open(name, flags, 0600);
    if (fd < 0) die("open branch marker");
    struct stat st;
    if (fstat(fd, &st)) die("stat branch marker");
    if (!S_ISREG(st.st_mode) || st.st_size != (create ? 0 : MARKER_BYTES)) {
        fprintf(stderr, "branch marker is not a regular file of expected size\n"); exit(2);
    }
    int n = snprintf(data, sizeof(data), "clanker-latency-v2 %" PRIu64 " %" PRIu64 " %u", workspace_mib * MIB, workspace_files, branch);
    if (n < 0 || (size_t)n >= sizeof(data) - 1) { fprintf(stderr, "branch marker exceeds fixed record\n"); exit(2); }
    memset(data + n, ' ', sizeof(data) - (size_t)n);
    data[sizeof(data) - 1] = '\n';
    size_t count = 0;
    while (count < sizeof(data)) {
        ssize_t written = pwrite(fd, data + count, sizeof(data) - count, (off_t)count);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) die("pwrite branch marker");
        count += (size_t)written;
    }
    if (fsync(fd)) die("fsync branch marker");
    close(fd);
    if (create) {
        fd = open(workspace, O_RDONLY);
        if (fd < 0 || fsync(fd)) die("fsync workspace");
        close(fd);
    }
}
static void initialize(void) {
    ram_size = (size_t)(memory_mib * MIB);
    ram = mmap(NULL, ram_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (ram == MAP_FAILED) die("mmap memory");
    volatile uint64_t *words = (volatile uint64_t *)ram;
    for (size_t i = 0; i < ram_size / sizeof(*words); i++) words[i] = mix(i);
    if (mkdir(workspace, 0700) && errno != EEXIST) die("mkdir workspace");
    char name[PATH_MAX]; path(name, "branch-marker");
    uint64_t total = workspace_mib * MIB;
    if (!total) workspace_files = 0;
    bool existing = !access(name, F_OK);
    if (existing && !reuse_workspace) { fprintf(stderr, "workspace already initialized; use --reuse-workspace or a fresh workspace\n"); exit(2); }
    if (existing && !disk_branch(&branch)) { fprintf(stderr, "workspace metadata does not match requested profile\n"); exit(2); }
    uint64_t block[8192];
    for (uint64_t f = 0; f < workspace_files; f++) {
        char leaf[64]; snprintf(leaf, sizeof(leaf), "payload-%06" PRIu64 ".bin", f); path(name, leaf);
        uint64_t count = total / workspace_files + (f < total % workspace_files);
        if (existing) {
            struct stat st;
            if (lstat(name, &st) || !S_ISREG(st.st_mode) || (uint64_t)st.st_size != count) {
                fprintf(stderr, "existing workspace payload missing or wrong size: %s\n", name); exit(2);
            }
            continue;
        }
        int fd = open(name, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd < 0) die("create workspace payload");
        uint64_t offset = 0;
        while (offset < count) {
            size_t n = count - offset < sizeof(block) ? (size_t)(count - offset) : sizeof(block);
            for (size_t i = 0; i < sizeof(block) / sizeof(*block); i++) block[i] = mix((f << 40) ^ (offset / 8 + i));
            write_all(fd, block, n); offset += n;
        }
        if (fsync(fd)) die("fsync workspace payload");
        close(fd);
    }
    if (!existing) save_branch(true);
}
static void *heartbeat(void *unused) {
    (void)unused;
    for (;;) {
        nap(1000000L);
        pthread_mutex_lock(&mu);
        uint64_t m = mono(), r = raw();
        uint64_t dm = m - last_mono, dr = r - last_raw;
        mono_ring[sample_count % RING] = dm; raw_ring[sample_count % RING] = dr;
        sample_count++;
        if (dm > max_mono) max_mono = dm;
        if (dr > max_raw) max_raw = dr;
        last_mono = m; last_raw = r;
        pthread_mutex_unlock(&mu);
    }
    return NULL;
}
static void *dirty(void *unused) {
    (void)unused;
    size_t cursor = 0;
    uint64_t generation = 1;
    for (;;) {
        uint64_t begin = mono();
        pthread_mutex_lock(&mu);
        while (paused) pthread_cond_wait(&cv, &mu);
        dirty_busy = true;
        pthread_mutex_unlock(&mu);
        /* One 10ms quota; never catch up a VM stall with a write burst. */
        uint64_t quota = dirty_mib_s * MIB / 100;
        uint64_t done = 0, passes = 0;
        while (done < quota) {
            /* Preserve one immutable sentinel in every populated page. */
            if (!(cursor % PAGE)) cursor += sizeof(uint64_t);
            *(volatile uint64_t *)(ram + cursor) = mix(cursor ^ (generation << 32));
            cursor += sizeof(uint64_t); done += sizeof(uint64_t);
            if (cursor == ram_size) { cursor = 0; generation++; passes++; }
        }
        pthread_mutex_lock(&mu);
        dirty_bytes += done; dirty_passes += passes; dirty_busy = false;
        pthread_cond_broadcast(&cv);
        pthread_mutex_unlock(&mu);
        uint64_t elapsed = mono() - begin;
        if (elapsed < 10000000ULL) nap((long)(10000000ULL - elapsed));
    }
    return NULL;
}
static int compare_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}
static uint64_t quantile(const uint64_t *ring, size_t n, unsigned p) {
    if (!n) return 0;
    uint64_t values[RING]; memcpy(values, ring, n * sizeof(*ring));
    qsort(values, n, sizeof(*values), compare_u64);
    return values[((n - 1) * p) / 100];
}
static void array(FILE *out, const uint64_t *ring, uint64_t count) {
    uint64_t first = count > RECENT ? count - RECENT : 0;
    fputc('[', out);
    for (uint64_t i = first; i < count; i++) fprintf(out, "%s%" PRIu64, i == first ? "" : ",", ring[i % RING]);
    fputc(']', out);
}
static void status(FILE *out) {
    bool memory_ok = true;
    /* Check every page's sentinel, including pages outside the dirty cursor. */
    for (size_t i = 0; i < ram_size; i += PAGE)
        if (*(uint64_t *)(ram + i) != mix(i / sizeof(uint64_t))) memory_ok = false;
    unsigned db = 0; bool disk_ok = disk_branch(&db);
    pthread_mutex_lock(&mu);
    uint64_t mr[RING], rr[RING];
    memcpy(mr, mono_ring, sizeof(mr)); memcpy(rr, raw_ring, sizeof(rr));
    uint64_t count = sample_count, mm = max_mono, rm = max_raw, bytes = dirty_bytes, passes = dirty_passes;
    bool is_paused = paused;
    pthread_mutex_unlock(&mu);
    size_t n = count < RING ? (size_t)count : RING;
    fprintf(out, "{\"ok\":true,\"ready\":true,\"pid\":%ld,\"start_monotonic_ns\":%" PRIu64
        ",\"ram_marker\":\"%016" PRIx64 "\",\"branch\":%u,\"disk_branch\":%u,\"memory_ok\":%s,\"disk_ok\":%s,"
        "\"memory_mib\":%" PRIu64 ",\"workspace_mib\":%" PRIu64 ",\"workspace_files\":%" PRIu64
        ",\"dirty_mib_s\":%" PRIu64 ",\"writes_paused\":%s,\"dirty_bytes\":%" PRIu64 ",\"dirty_passes\":%" PRIu64
        ",\"heartbeat\":{\"samples\":%" PRIu64 ",\"window_samples\":%zu,\"window_capacity\":%u,\"recent_capacity\":%u,"
        "\"max_gap_monotonic_ns\":%" PRIu64 ",\"max_gap_raw_ns\":%" PRIu64
        ",\"p50_gap_monotonic_ns\":%" PRIu64 ",\"p99_gap_monotonic_ns\":%" PRIu64
        ",\"p50_gap_raw_ns\":%" PRIu64 ",\"p99_gap_raw_ns\":%" PRIu64 ",\"raw_clock_supported\":%s,\"recent_gap_monotonic_ns\":",
        (long)getpid(), started_ns, ram_marker, branch, db, memory_ok ? "true" : "false",
        disk_ok && db == branch ? "true" : "false", memory_mib, workspace_mib, workspace_files,
        dirty_mib_s, is_paused ? "true" : "false", bytes, passes, count, n, RING, RECENT,
        mm, rm, quantile(mr,n,50), quantile(mr,n,99), quantile(rr,n,50), quantile(rr,n,99),
#ifdef CLOCK_MONOTONIC_RAW
        "true"
#else
        "false"
#endif
    );
    array(out, mr, count); fputs(",\"recent_gap_raw_ns\":", out); array(out, rr, count);
    fputs("}}\n", out);
}
static void ws(const char **p) { while (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n') (*p)++; }
static bool token(const char **p, const char *s) {
    ws(p); size_t n = strlen(s);
    if (strncmp(*p, s, n)) return false;
    *p += n; return true;
}
static bool string(const char **p, char *out, size_t cap) {
    if (!token(p, "\"")) return false;
    size_t n = 0;
    while (**p && **p != '"') {
        if ((unsigned char)**p < 32 || **p == '\\' || n + 1 >= cap) return false;
        out[n++] = *(*p)++;
    }
    out[n] = 0; return token(p, "\"");
}
static bool parse(const char *p, char op[32], unsigned *value) {
    bool have_op = false, have_branch = false;
    if (!token(&p, "{")) return false;
    do {
        char key[32]; if (!string(&p, key, sizeof(key)) || !token(&p, ":")) return false;
        if (!strcmp(key, "op") && !have_op) { if (!string(&p, op, 32)) return false; have_op = true; }
        else if (!strcmp(key, "branch") && !have_branch) {
            ws(&p); if (*p < '1' || *p > '9') return false;
            errno = 0; char *end; unsigned long v = strtoul(p, &end, 10);
            if (errno || v > INT_MAX) return false;
            *value = (unsigned)v; p = end; have_branch = true;
        } else return false;
        ws(&p); if (*p != ',') break; p++;
    } while (true);
    if (!token(&p, "}")) return false;
    ws(&p);
    if (*p || !have_op) return false;
    if (!strcmp(op, "mutate")) return have_branch;
    return !have_branch && (!strcmp(op,"status") || !strcmp(op,"reset_metrics") || !strcmp(op,"pause_writes") || !strcmp(op,"resume_writes"));
}
static void handle(FILE *out, const char *request) {
    char op[32]; unsigned value = 0;
    if (!parse(request, op, &value)) { fputs("{\"ok\":false,\"error\":\"invalid_request\"}\n", out); return; }
    if (!strcmp(op, "reset_metrics")) {
        pthread_mutex_lock(&mu);
        sample_count = max_mono = max_raw = dirty_bytes = dirty_passes = 0;
        last_mono = mono(); last_raw = raw();
        pthread_mutex_unlock(&mu);
    } else if (!strcmp(op,"pause_writes")) {
        pthread_mutex_lock(&mu); paused = true;
        while (dirty_busy) pthread_cond_wait(&cv, &mu);
        pthread_mutex_unlock(&mu);
    } else if (!strcmp(op,"resume_writes")) {
        pthread_mutex_lock(&mu); paused = false; pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu);
    } else if (!strcmp(op,"mutate")) { branch = value; save_branch(false); }
    status(out);
}
static void address(struct sockaddr_un *addr) {
    memset(addr, 0, sizeof(*addr)); addr->sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(addr->sun_path)) { fprintf(stderr,"socket path too long\n"); exit(2); }
    strcpy(addr->sun_path, socket_path);
}
static void serve(void) {
    started_ns = mono(); ram_marker = mix(started_ns ^ (uint64_t)getpid() ^ raw());
    initialize();
    int sock = socket(AF_UNIX, SOCK_STREAM, 0); if (sock < 0) die("socket");
    struct sockaddr_un addr; address(&addr);
    /* Never unlink someone else's socket. Supply a fresh path for each run. */
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr))) die("bind");
    if (chmod(socket_path, 0600) || listen(sock, 16)) die("listen");
    pthread_t ht, dt; last_mono = mono(); last_raw = raw();
    if (pthread_create(&ht, NULL, heartbeat, NULL) || pthread_create(&dt, NULL, dirty, NULL)) { fprintf(stderr,"pthread_create failed\n"); exit(1); }
    printf("{\"ready\":true,\"pid\":%ld}\n", (long)getpid()); fflush(stdout);
    for (;;) {
        int fd = accept(sock, NULL, NULL);
        if (fd < 0 && errno == EINTR) continue;
        if (fd < 0) die("accept");
        struct timeval timeout = {2,0};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        char request[REQUEST_MAX + 2];
        size_t count = 0; bool complete = false, invalid = false;
        while (count < REQUEST_MAX) {
            char c; ssize_t n = read(fd, &c, 1);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            if (!c) invalid = true;
            request[count++] = c;
            if (c == '\n') { complete = true; break; }
        }
        request[count] = 0;
        FILE *io = fdopen(fd, "w"); if (!io) { close(fd); continue; }
        if (complete && !invalid)
            handle(io, request);
        else fputs("{\"ok\":false,\"error\":\"request_too_long_or_incomplete\"}\n", io);
        fclose(io);
    }
}
static uint64_t number(const char *s, uint64_t max) {
    if (!*s) { fprintf(stderr,"empty numeric option\n"); exit(2); }
    for (const char *p = s; *p; p++) if (*p < '0' || *p > '9') { fprintf(stderr,"invalid numeric option\n"); exit(2); }
    errno = 0; char *end; unsigned long long v = strtoull(s, &end, 10);
    if (errno || *end || v > max) { fprintf(stderr,"numeric option out of range\n"); exit(2); }
    return v;
}
static void usage(void) {
    fprintf(stderr,"usage: latency-guest serve [--memory-mib N] [--dirty-mib-s N] [--workspace-mib N] [--workspace-files N] [--workspace PATH] [--socket PATH] [--reuse-workspace]\n       latency-guest call [--socket PATH] '{\"op\":\"status\"}'\n"); exit(2);
}
int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc < 2) usage();
    if (!strcmp(argv[1], "call")) {
        int i = 2;
        if (i < argc && !strcmp(argv[i],"--socket")) { if (i + 1 >= argc) usage(); socket_path = argv[i+1]; i += 2; }
        if (i + 1 != argc || strlen(argv[i]) + 1 > REQUEST_MAX || strchr(argv[i], '\n')) usage();
        int sock = socket(AF_UNIX, SOCK_STREAM, 0); if (sock < 0) die("socket");
        struct sockaddr_un addr; address(&addr);
        if (connect(sock, (struct sockaddr *)&addr, sizeof(addr))) die("connect");
        write_all(sock, argv[i], strlen(argv[i])); write_all(sock, "\n", 1);
        char buf[4096]; ssize_t n;
        while ((n = read(sock, buf, sizeof(buf))) > 0) write_all(STDOUT_FILENO, buf, (size_t)n);
        if (n < 0) die("read reply");
        close(sock); return 0;
    }
    if (strcmp(argv[1], "serve")) usage();
    for (int i = 2; i < argc; i += 2) {
        if (!strcmp(argv[i],"--reuse-workspace")) { reuse_workspace = true; i--; continue; }
        if (i + 1 >= argc) usage();
        const char *k = argv[i], *v = argv[i+1];
        if (!strcmp(k,"--memory-mib")) memory_mib = number(v,8192);
        else if (!strcmp(k,"--workspace-mib")) workspace_mib = number(v,16384);
        else if (!strcmp(k,"--workspace-files")) workspace_files = number(v,65536);
        else if (!strcmp(k,"--dirty-mib-s")) dirty_mib_s = number(v,4096);
        else if (!strcmp(k,"--socket")) socket_path = v;
        else if (!strcmp(k,"--workspace")) workspace = v;
        else usage();
    }
    if (!memory_mib || (workspace_mib && !workspace_files) || !*workspace || !*socket_path) usage();
    serve(); return 0;
}
