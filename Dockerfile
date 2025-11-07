# Stage 1: Builder - Compile Python from source
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS python-builder

# Install build dependencies for Python compilation
RUN dnf install -y \
    bzip2-devel \
    gcc \
    gcc-c++ \
    gzip \
    libffi-devel \
    make \
    openssl-devel \
    readline-devel \
    sqlite-devel \
    tar \
    zlib-devel \
    && dnf clean all

# Compile Python 3.13.1 from source (matching Vercel's exact build)
# Using the same configure flags as Vercel: --enable-optimizations --prefix=/vercel/runtimes/python
# Note: NO --enable-shared to avoid dynamic linking issues (Vercel uses static linking)
RUN curl -fsSL https://www.python.org/ftp/python/3.13.1/Python-3.13.1.tgz | tar -xz -C /tmp && \
    cd /tmp/Python-3.13.1 && \
    ./configure --enable-optimizations --prefix=/vercel/runtimes/python && \
    make -j$(nproc) && \
    make install && \
    cd /vercel/runtimes/python/bin && \
    ln -s python3.13 python && \
    ln -s pip3 pip && \
    cd / && \
    rm -rf /tmp/Python-3.13.1

# Stage 2: Runtime - Final image
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Install packages (matching Vercel Sandbox)
RUN dnf install -y \
    bind-utils \
    bzip2 \
    findutils \
    git \
    gzip \
    iputils \
    libicu \
    libjpeg-turbo \
    libpng \
    ncurses-libs \
    openssl \
    openssl-libs \
    procps-ng \
    shadow-utils \
    sudo \
    tar \
    unzip \
    which \
    whois \
    zstd \
    && dnf clean all

# Create vercel-sandbox user matching Vercel's setup (uid=1000, gid=1000)
RUN groupadd -g 1000 vercel-sandbox && \
    useradd -u 1000 -g 1000 -m -s /bin/bash vercel-sandbox

# Configure passwordless sudo for vercel-sandbox user (matching Vercel Sandbox)
RUN echo "vercel-sandbox ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/vercel-sandbox && \
    chmod 0440 /etc/sudoers.d/vercel-sandbox

# Install Node.js 22 runtime (matching v22.14.0 in Vercel Sandbox)
# Detect architecture and download appropriate Node.js binary
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then NODE_ARCH="x64"; \
    elif [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; \
    else echo "Unsupported architecture: $ARCH" && exit 1; fi && \
    curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${NODE_ARCH}.tar.gz | tar -xz -C /tmp && \
    mkdir -p /vercel/runtimes/node22 && \
    mv /tmp/node-v22.14.0-linux-${NODE_ARCH}/* /vercel/runtimes/node22/ && \
    rm -rf /tmp/node-v22.14.0-linux-${NODE_ARCH}

# Install pnpm globally in Node.js installation (matching 10.19.0)
RUN /vercel/runtimes/node22/bin/node /vercel/runtimes/node22/bin/npm install -g pnpm@10.19.0

# Copy compiled Python from builder stage
COPY --from=python-builder /vercel/runtimes/python /vercel/runtimes/python

# Install uv (fast Python package installer, matching Vercel)
RUN curl -fsSL https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /vercel/runtimes/python/bin/uv && \
    mv /root/.local/bin/uvx /vercel/runtimes/python/bin/uvx

# Create Vercel directory structure
RUN mkdir -p /vercel/bin /vercel/sandbox && \
    chown -R vercel-sandbox:vercel-sandbox /vercel && \
    chmod 755 /vercel

# Create home directory structure for vercel-sandbox user
RUN mkdir -p /home/vercel-sandbox/.global/npm /home/vercel-sandbox/.global/pnpm /home/vercel-sandbox/.local/bin && \
    chown -R vercel-sandbox:vercel-sandbox /home/vercel-sandbox/.global /home/vercel-sandbox/.local

# Set up Git in /opt/git to match Vercel's structure
RUN mkdir -p /opt/git/bin && \
    ln -s /usr/bin/git /opt/git/bin/git

# Copy sandbox management script
COPY sandbox.sh /vercel/bin/sandbox.sh
RUN chmod +x /vercel/bin/sandbox.sh

# Set environment variables to include both Node.js and Python runtimes in PATH
# This allows the container to support multiple runtimes simultaneously
ENV PATH=/vercel/runtimes/python/bin:/vercel/runtimes/node22/bin:/home/vercel-sandbox/.global/pnpm/bin:/home/vercel-sandbox/.global/npm/bin:/vercel/bin:/opt/git/bin:/home/vercel-sandbox/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
ENV HOME=/home/vercel-sandbox

# Switch to vercel-sandbox user
USER vercel-sandbox
WORKDIR /home/vercel-sandbox

# Run the sandbox manager as the entrypoint
ENTRYPOINT ["/vercel/bin/sandbox.sh", "start"]