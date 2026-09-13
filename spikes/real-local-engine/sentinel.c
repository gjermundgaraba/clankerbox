#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <string.h>
int main(void) {
 uint64_t token=0, count=0; int r=open("/dev/urandom",O_RDONLY); if(read(r,&token,sizeof token)!=sizeof token)return 2; close(r);
 int s=socket(AF_INET,SOCK_STREAM,0),one=1;setsockopt(s,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(18080),.sin_addr.s_addr=0};
 if(bind(s,(void*)&a,sizeof a)||listen(s,8))return 3;
 for(;;){int c=accept(s,0,0);if(c<0)continue;char in[2048];int n=read(c,in,sizeof in);if(n<=0){close(c);continue;}if(n>=4&&!memcmp(in,"POST",4))count++;
 char body[256],out[512];int z=snprintf(body,sizeof body,"{\"token\":\"%016llx\",\"pid\":%d,\"count\":%llu}\n",(unsigned long long)token,getpid(),(unsigned long long)count);
 int k=snprintf(out,sizeof out,"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",z,body);write(c,out,k);close(c);}
}
