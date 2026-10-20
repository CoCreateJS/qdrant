/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * Licensed under GNU AGPLv3.
 ********************************************************************************/

import path from "node:path";
import { fileURLToPath } from "node:url";
import webpack from "webpack";
import { FileUploader } from "@cocreate/webpack";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (env, argv) => {
    const isProduction = argv && argv.mode === "production";

    // Base configuration shared across all build targets
    const baseConfig = {
        target: "node",
        experiments: {
            outputModule: true
        },
        resolve: {
            extensions: [".js", ".mjs", ".cjs", ".json", ".ts"],
            fullySpecified: false
        },
        node: {
            __dirname: false,
            __filename: false
        },
        devtool: false,
        module: {
            rules: [
                {
                    test: /\.m?[jc]s$/,
                    type: "javascript/auto",
                    resolve: {
                        fullySpecified: false
                    }
                },
                {
                    test: /\.js$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "js",
                            target: "node18"
                        }
                    }
                },
                {
                    test: /\.ts$/,
                    exclude: [/node_modules/, /\.d\.ts$/],
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "ts",
                            target: "node18"
                        }
                    }
                }
            ]
        },
        performance: {
            hints: false
        }
    };

    const commonPlugins = [
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1
        }),
        // Ignore optional terminal formatting, documentation, and cloud metadata providers
        new webpack.IgnorePlugin({
            resourceRegExp: /^(cardinal|gcp-metadata|aws-sdk|\.d\.ts)$/
        })
    ];

    const distributionConfig = {
        ...baseConfig,
        name: "distribution",
        mode: isProduction ? "production" : "development",
        entry: "./src/index.js",
        output: {
            path: path.resolve(__dirname, "dist"),
            filename: "qdrant.js",
            library: {
                type: "module"
            },
            clean: true,
            globalObject: "this"
        },
        optimization: {
            // Keep driver and utility identifiers intact in production.
            minimize: false,
            concatenateModules: false,
            splitChunks: false,
            runtimeChunk: false
        },
        plugins: [
            ...commonPlugins,
            new FileUploader(env, argv)
        ]
    };

    return [distributionConfig];
};
