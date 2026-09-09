#!/usr/bin/env python3
"""Offline routing probe. Uses fake credentials, temporary config, loopback only."""
import http.server, json, os, pathlib, socketserver, subprocess, tempfile, threading

HERE = pathlib.Path(__file__).resolve().parent
requests = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self): self.respond()
    def do_POST(self): self.respond()
    def do_CONNECT(self):
        requests.append({'method': 'CONNECT', 'path': self.path})
        self.send_error(502, 'External connections prohibited by offline probe')
    def respond(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        requests.append({'method': self.command, 'path': self.path, 'host': self.headers.get('Host'), 'authorization': self.headers.get('Authorization'), 'body': body})
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        if '/paginate' in self.path:
            page = 2 if 'page=2' in self.path else 1
            payload = [{'page': page}]
            if page == 1: self.send_header('Link', '<https://api.github.com/paginate?page=2>; rel="next"')
        elif self.command == 'POST':
            query = json.loads(body).get('query', '')
            if 'createPullRequest' in query:
                payload = {'data': {'createPullRequest': {'pullRequest': {'id': 'PR_mock', 'number': 124, 'url': 'https://github.com/owner/repo/pull/124'}}}}
            elif 'PullRequestForBranch' in query:
                payload = {'data': {'repository': {'pullRequests': {'nodes': []}, 'defaultBranchRef': {'name': 'main'}}}}
            elif 'pullRequests' in query:
                payload = {'data': {'repository': {'pullRequests': {'nodes': [{'number': 123, 'title': 'Mock PR', 'url': 'https://github.com/owner/repo/pull/123', 'state': 'OPEN'}], 'pageInfo': {'hasNextPage': False, 'endCursor': ''}, 'totalCount': 1}}}}
            elif 'repository' in query:
                payload = {'data': {'repository': {'id': 'R_mock', 'name': 'repo', 'nameWithOwner': 'owner/repo', 'url': 'https://github.com/owner/repo', 'owner': {'login': 'owner'}, 'isFork': False, 'isArchived': False, 'isPrivate': True, 'defaultBranchRef': {'name': 'main'}}}}
            else: payload = {'data': {'viewer': {'login': 'probe-user'}}}
        else: payload = {'login': 'probe-user', 'full_name': 'owner/repo'}
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

with tempfile.TemporaryDirectory(prefix='clankerbox-gh-probe-') as directory:
    root = pathlib.Path(directory)
    tcp = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=tcp.serve_forever, daemon=True).start()
    endpoint = 'http://127.0.0.1:' + str(tcp.server_port)
    class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer): pass
    unix = UnixServer(str(root / 'relay.sock'), Handler)
    threading.Thread(target=unix.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GH_', 'GITHUB_', 'GIT_', 'XDG_')) and k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
    env.update(HOME=str(root), GH_CONFIG_DIR=str(root / 'config'), GH_TOKEN='clankerbox-github-placeholder', GH_PROMPT_DISABLED='1', GH_TELEMETRY='disabled', HTTP_PROXY=endpoint, HTTPS_PROXY=endpoint, ALL_PROXY=endpoint, NO_PROXY='127.0.0.1,localhost', GIT_CONFIG_NOSYSTEM='1')
    results = {'version': subprocess.check_output(['gh', '--version'], text=True).splitlines()[0], 'cases': []}
    def run(name, args):
        start = len(requests)
        out = subprocess.run(args, env=env, cwd=root, capture_output=True, text=True, timeout=20)
        result = {'name': name, 'command': args, 'exit': out.returncode, 'stdout': out.stdout, 'stderr': out.stderr, 'requests': requests[start:]}
        results['cases'].append(result)
        return result
    run('init', ['git', 'init', '-q'])
    run('remote', ['git', 'remote', 'add', 'origin', 'git@github.com:owner/repo.git'])
    run('api-host-http-config', ['gh', 'config', 'set', 'api_host', endpoint, '--host', 'github.com'])
    run('api-host-http-rest', ['gh', 'api', 'user'])
    run('api-host-http-graphql', ['gh', 'api', 'graphql', '-f', 'query=query { viewer { login } }'])
    run('api-host-http-pagination', ['gh', 'api', '--paginate', 'paginate'])
    run('api-host-http-pr-list', ['gh', 'pr', 'list', '--json', 'number,title,url'])
    run('api-host-http-repo-view', ['gh', 'repo', 'view', '--json', 'nameWithOwner,url'])
    run('api-host-unset', ['gh', 'config', 'set', 'api_host', '', '--host', 'github.com'])
    run('unix-socket-config', ['gh', 'config', 'set', 'http_unix_socket', str(root / 'relay.sock')])
    run('unix-rest', ['gh', 'api', 'user'])
    run('unix-graphql', ['gh', 'api', 'graphql', '-f', 'query=query { viewer { login } }'])
    run('unix-pagination', ['gh', 'api', '--paginate', 'paginate'])
    run('unix-pr-list', ['gh', 'pr', 'list', '--json', 'number,title,url'])
    run('unix-repo-view', ['gh', 'repo', 'view', '--json', 'nameWithOwner,url'])
    run('unix-pr-create', ['gh', 'pr', 'create', '--repo', 'owner/repo', '--base', 'main', '--head', 'probe', '--title', 'fixture', '--body', 'fixture'])
    tcp.shutdown(); unix.shutdown()
    (HERE / 'gh-results.json').write_text(json.dumps(results, indent=2) + '\n')
    for case in results['cases']: print(case['name'], case['exit'], case['stderr'].strip(), case['stdout'].strip(), 'requests=', len(case['requests']))
    indexed = {case['name']: case for case in results['cases']}
    for name in ('unix-rest', 'unix-graphql', 'unix-pagination', 'unix-pr-list', 'unix-repo-view', 'unix-pr-create'):
        assert indexed[name]['exit'] == 0, indexed[name]
        assert indexed[name]['requests'], name
        for request in indexed[name]['requests']:
            assert request['host'] == 'api.github.com', request
            assert request['authorization'] == 'token clankerbox-github-placeholder', request
    assert len(indexed['unix-pagination']['requests']) == 2
    assert json.loads(indexed['unix-repo-view']['stdout'])['nameWithOwner'] == 'owner/repo'
    assert json.loads(indexed['unix-pr-list']['stdout'])[0]['url'] == 'https://github.com/owner/repo/pull/123'
    created = indexed['unix-pr-create']
    assert created['stdout'].strip() == 'https://github.com/owner/repo/pull/124'
    mutations = [json.loads(request['body']) for request in created['requests'] if 'createPullRequest' in request['body']]
    assert len(mutations) == 1
    assert mutations[0]['variables']['input'] == {'baseRefName': 'main', 'body': 'fixture', 'draft': False, 'headRefName': 'probe', 'maintainerCanModify': True, 'repositoryId': 'R_mock', 'title': 'fixture'}
    assert not any(request['method'] == 'CONNECT' for request in requests), 'Unexpected non-loopback request blocked'

