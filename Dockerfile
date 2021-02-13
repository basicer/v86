FROM ubuntu:latest
ENV DEBIAN_FRONTEND noninteractive
RUN \
        dpkg --add-architecture i386 && \
        apt-get update -qq && \
        apt-get install -y nasm gdb unzip p7zip-full openjdk-8-jre wget python python3 qemu-system-x86 git-core build-essential libc6-dev-i386-cross libc6-dev-i386 curl clang clang-11 clang++-11 llvm && \
        update-alternatives --install /usr/bin/clang clang /usr/bin/clang-11 100 && \
        wget https://nodejs.org/dist/v14.15.5/node-v14.15.5-linux-x64.tar.xz && \
        tar xfv node-v14.15.5-linux-x64.tar.xz && \
        rm node-v14.15.5-linux-x64.tar.xz && \
        wget https://sh.rustup.rs -O rustup.sh && \
        sh ./rustup.sh -y && \
        rm ./rustup.sh && \
        export PATH="$HOME/.cargo/bin:$PATH" && \
        rustup default nightly && \
        rustup target add wasm32-unknown-unknown --toolchain nightly && \
        rustup component add rustfmt-preview --toolchain nightly && \
        apt-get clean && \
        apt-get autoclean && \
        apt-get autoremove && \
        rm -rf /var/lib/apt/lists/*

ENV PATH="/node-v14.15.5-linux-x64/bin/:${PATH}"
ENV PATH="/root/.cargo/bin:${PATH}"

RUN \
        curl https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/v20210202/closure-compiler-v20210202.jar > /opt/closure-compiler.jar && \
        echo '#!/bin/sh -e\nCC="/opt/closure-compiler.jar"\nexec java -jar $CC $*' > closure-compiler && \
        chmod +x closure-compiler

ADD . /opt
RUN cd /opt && make all && make all-debug
RUN cd /opt && make build/xterm.js build/libwabt.js

FROM nginx:alpine

RUN rm -r /usr/share/nginx/html/*
COPY --from=0 /opt/build/* /usr/share/nginx/html/build/
ADD *.html *.js *.css /usr/share/nginx/html/
ADD src /usr/share/nginx/html/src
ADD lib /usr/share/nginx/html/lib
ADD bios /usr/share/nginx/html/bios

RUN sed -i '12i\    location ~ images/ { resolver 8.8.8.8; proxy_pass http://copy.sh/v86$request_uri; }' /etc/nginx/conf.d/default.conf
