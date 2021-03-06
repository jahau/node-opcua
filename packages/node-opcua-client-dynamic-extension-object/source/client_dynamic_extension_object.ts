// tslint:disable: no-console
/**
 * @module node-opcua-client-dynamic-extension-object
 */
import * as chalk from "chalk";
import * as _ from "underscore";

import { assert } from "node-opcua-assert";
import {
    AttributeIds,
    makeNodeClassMask,
    makeResultMask, NodeClass, QualifiedName
} from "node-opcua-data-model";
import { DataValue } from "node-opcua-data-value";
import {
    checkDebugFlag,
    make_debugLog
} from "node-opcua-debug";
import {
    BasicTypeDefinition,
    BasicTypeSchema,
    ConstructorFuncWithSchema,
    DataTypeFactory,
    FieldCategory,
    FieldInterfaceOptions,
    getBuildInType,
    StructuredTypeOptions,
    StructuredTypeSchema,
    TypeDefinition,
    TypeSchemaBase,
    getStandartDataTypeFactory,
} from "node-opcua-factory";
import {
    ExpandedNodeId,
    makeExpandedNodeId,
    NodeId,
    resolveNodeId,
    sameNodeId
} from "node-opcua-nodeid";
import {
    BrowseDescriptionLike,
    IBasicSession,
    ReadValueIdLike
} from "node-opcua-pseudo-session";
import {
    createDynamicObjectConstructor,
    DataTypeAndEncodingId,
    MapDataTypeAndEncodingIdProvider,
    parseBinaryXSDAsync,
} from "node-opcua-schemas";
import {
    BrowseDescriptionOptions,
    BrowseDirection,
    BrowseResult,
    ReferenceDescription,
} from "node-opcua-service-browse";
import {
    makeBrowsePath
} from "node-opcua-service-translate-browse-path";
import {
    StatusCodes
} from "node-opcua-status-code";
import {
    DataTypeDefinition,
    EnumDefinition,
    StructureDefinition,
    StructureType,
} from "node-opcua-types";
import {
    ExtraDataTypeManager
} from "./extra_data_type_manager";

const doDebug = checkDebugFlag(__filename);
const debugLog = make_debugLog(__filename);

async function _readDeprecatedFlag(session: IBasicSession, dataTypeDictionary: NodeId): Promise<boolean> {

    const browsePath = makeBrowsePath(dataTypeDictionary, ".Deprecated");
    const a = await session.translateBrowsePath(browsePath);
    /* istanbul ignore next */
    if (!a.targets || a.targets.length === 0) {
        debugLog("Cannot find Deprecated property for dataTypeDictionary " + dataTypeDictionary.toString());
        return false;
    }
    const deprecatedFlagNodeId = a.targets[0].targetId;
    const dataValue = await session.read({ nodeId: deprecatedFlagNodeId, attributeId: AttributeIds.Value });
    return dataValue.value.value;
}

async function _readNamespaceUriProperty(session: IBasicSession, dataTypeDictionary: NodeId): Promise<string> {
    const a = await session.translateBrowsePath(makeBrowsePath(dataTypeDictionary, ".NamespaceUri"));
    /* istanbul ignore next */
    if (!a.targets || a.targets.length === 0) {
        return "??dataTypeDictionary doesn't expose NamespaceUri property??";
    }
    const namespaceUriProp = a.targets[0].targetId;
    const dataValue = await session.read({ nodeId: namespaceUriProp, attributeId: AttributeIds.Value });
    return dataValue.value.value || "<not set>";
}

async function _getDataTypeDescriptions(
    session: IBasicSession,
    dataTypeDictionaryNodeId: NodeId
): Promise<IDataTypeDescriptuon[]> {

    const nodeToBrowse2 = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: dataTypeDictionaryNodeId,
        referenceTypeId: resolveNodeId("HasComponent"),
        // resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
        resultMask: makeResultMask("NodeId | BrowseName")
    };
    const result2 = await session.browse(nodeToBrowse2);
    result2.references = result2.references || [];
    return result2.references.map((r) => ({ nodeId: r.nodeId, browseName: r.browseName }));
}

async function _enrichWithDescriptionOf(
    session: IBasicSession,
    dataTypeDescriptions: IDataTypeDescriptuon[]
): Promise<NodeId[]> {
    const nodesToBrowse3: BrowseDescriptionOptions[] = [];
    for (const ref of dataTypeDescriptions) {
        ref.browseName.toString();
        nodesToBrowse3.push({
            browseDirection: BrowseDirection.Inverse,
            includeSubtypes: false,
            nodeClassMask: makeNodeClassMask("Object"),
            nodeId: ref.nodeId.toString(),
            referenceTypeId: resolveNodeId("HasDescription"),
            //            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
            resultMask: makeResultMask("NodeId")
        });
    }
    const results3 = await session.browse(nodesToBrowse3);

    const binaryEncodings = [];
    const nodesToBrowseDataType: BrowseDescriptionOptions[] = [];

    let i = 0;
    for (const result3 of results3) {

        const dataTypeDescription = dataTypeDescriptions[i++];

        result3.references = result3.references || [];
        assert(result3.references.length === 1);
        for (const ref of result3.references) {

            const binaryEncodingNodeId = ref.nodeId;
            dataTypeDescription.encodings = dataTypeDescription.encodings || {
                binaryEncodingNodeId: NodeId.nullNodeId,
                dataTypeNodeId: NodeId.nullNodeId,
                jsonEncodingNodeId: NodeId.nullNodeId,
                xmlEncodingNodeId: NodeId.nullNodeId
            };
            dataTypeDescription.encodings.binaryEncodingNodeId = binaryEncodingNodeId;
            binaryEncodings.push(binaryEncodingNodeId);
            nodesToBrowseDataType.push({
                browseDirection: BrowseDirection.Inverse,
                includeSubtypes: false,
                nodeClassMask: makeNodeClassMask("DataType"),
                nodeId: ref.nodeId.toString(),
                referenceTypeId: resolveNodeId("HasEncoding"),
                //            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
                resultMask: makeResultMask("NodeId | BrowseName")
            });
        }
    }
    const results4 = await session.browse(nodesToBrowseDataType);
    const dataTypeNodeIds: NodeId[] = [];
    i = 0;
    for (const result4 of results4) {
        result4.references = result4.references || [];

        /* istanbul ignore next */
        if (result4.references.length !== 1) {
            console.log("What's going on ?", result4.toString());
        }

        for (const ref of result4.references) {
            const dataTypeNodeId = ref.nodeId;

            dataTypeNodeIds.push(dataTypeNodeId);

            const dataTypeDescription = dataTypeDescriptions[i++];
            dataTypeDescription.encodings!.dataTypeNodeId = dataTypeNodeId;
        }
    }
    return dataTypeNodeIds;
}

interface IDataTypeDescriptuon {
    browseName: QualifiedName;
    nodeId: NodeId;
    encodings?: DataTypeAndEncodingId;
    symbolicName?: string;
}
async function _findEncodings(session: IBasicSession, dataTypeNodeId: NodeId): Promise<DataTypeAndEncodingId> {
    const nodeToBrowse = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: true,
        nodeClassMask: makeNodeClassMask("Object"),
        nodeId: dataTypeNodeId,
        referenceTypeId: resolveNodeId("HasEncoding"),
        resultMask: makeResultMask("ReferenceType | IsForward | BrowseName | NodeClass | TypeDefinition")
    };
    const result = await session.browse(nodeToBrowse);
    const references = result.references || [];
    if (references.length === 0) {
        throw new Error("Cannot find encodings on type " + dataTypeNodeId.toString() + " statusCode " + result.statusCode.toString());
    }
    const encodings: DataTypeAndEncodingId = {
        dataTypeNodeId,

        binaryEncodingNodeId: NodeId.nullNodeId,
        jsonEncodingNodeId: NodeId.nullNodeId,
        xmlEncodingNodeId: NodeId.nullNodeId,
    };
    for (const ref of references) {
        switch (ref.browseName.name) {
            case "Default Binary":
                encodings.binaryEncodingNodeId = ref.nodeId;
                break;
            case "Default XML":
                encodings.xmlEncodingNodeId = ref.nodeId;
                break;
            case "Default JSON":
                encodings.jsonEncodingNodeId = ref.nodeId;
                break;
            default:
                console.log(" ignoring encoding ", ref.browseName.toString());
        }
    }
    return encodings;
}
interface IDataTypeDefInfo {
    className: string;
    dataTypeNodeId: NodeId;
    dataTypeDefinition: StructureDefinition;
}
type DataTypeDefinitions = IDataTypeDefInfo[];

function sortStructure(dataTypeDefinitions: DataTypeDefinitions) {

    const dataTypeDefinitionsSorted: IDataTypeDefInfo[] = [];
    const _visited: { [key: string]: IDataTypeDefInfo } = {};
    const _map: { [key: string]: IDataTypeDefInfo } = {};

    for (const d of dataTypeDefinitions) {
        _map[d.dataTypeNodeId.toString()] = d;
    }

    function _visit(d: IDataTypeDefInfo) {

        const hash = d.dataTypeNodeId.toString();
        if (_visited[hash]) {
            return;
        }
        const bbb = _map[d.dataTypeDefinition.baseDataType.toString()];
        if (bbb) {
            _visit(bbb);
        }

        for (const f of d.dataTypeDefinition.fields || []) {
            const ddd = _map[f.dataType.toString()];
            if (!ddd) {
                continue;
            }
            _visit(ddd);
        }
        _visited[hash] = d;
        dataTypeDefinitionsSorted.push(d);
    }
    for (const d of dataTypeDefinitions) {
        _visit(d);
    }
    return dataTypeDefinitionsSorted;
}

async function _extractDataTypeDictionaryFromDefinition(
    session: IBasicSession,
    dataTypeDictionaryNodeId: NodeId,
    dataTypeFactory: DataTypeFactory,
) {

    assert(dataTypeFactory, "expecting a dataTypeFactory");

    const dataTypeDescriptions = await _getDataTypeDescriptions(session, dataTypeDictionaryNodeId);
    const dataTypeNodeIds = await _enrichWithDescriptionOf(session, dataTypeDescriptions);

    // now read DataTypeDefition attributes of all the dataTypeNodeIds
    const nodesToRead: ReadValueIdLike[] = dataTypeNodeIds.map((nodeId: NodeId) => ({
        attributeId: AttributeIds.DataTypeDefinition, nodeId,
    }));

    const cache: { [key: string]: Cache } = {};
    const dataValuesWithDataTypeDefinition = await session.read(nodesToRead);

    assert(dataValuesWithDataTypeDefinition.length === dataTypeDescriptions.length);

    const dataTypeDefinitions: DataTypeDefinitions = [];

    let index = 0;
    for (const dataValue of dataValuesWithDataTypeDefinition) {

        const dataTypeNodeId = dataTypeNodeIds[index];
        const dataTypeDescription = dataTypeDescriptions[index];
        index++;

        /* istanbul ignore next */
        if (dataValue.statusCode !== StatusCodes.Good) {
            continue;
        }
        const dataTypeDefinition = dataValue.value.value;

        if (dataTypeDefinition && dataTypeDefinition instanceof StructureDefinition) {
            const className = dataTypeDescription.browseName.name!;
            dataTypeDefinitions.push({ className, dataTypeNodeId, dataTypeDefinition });
        }
    }
    // to do put in logicial order
    const dataTypeDefinitionsSorted = sortStructure(dataTypeDefinitions);

    for (const { className, dataTypeNodeId, dataTypeDefinition } of dataTypeDefinitionsSorted) {
        if (dataTypeFactory.hasStructuredType(className)) {
            continue;
        }
        // now fill typeDictionary
        try {
            const schema = await convertDataTypeDefinitionToStructureTypeSchema(
                session, dataTypeNodeId, className, dataTypeDefinition, dataTypeFactory, cache);
            // istanbul ignore next
            if (doDebug) {
                debugLog(chalk.red("Registering "), chalk.cyan(className.padEnd(30, " ")), schema.dataTypeNodeId.toString());
            }
            const Constructor = createDynamicObjectConstructor(schema, dataTypeFactory) as ConstructorFuncWithSchema;
            assert(Constructor.schema === schema);
        } catch (err) {
            console.log("Constructor verification err: ", err.message);
            console.log("For this reason class " + className + " has not been registered");
            console.log(err);
        }
    }

}

async function _extractNodeIds(
    session: IBasicSession,
    dataTypeDictionaryNodeId: NodeId
): Promise<MapDataTypeAndEncodingIdProvider> {

    const map: { [key: string]: DataTypeAndEncodingId } = {};

    const dataTypeDescriptions = await _getDataTypeDescriptions(session, dataTypeDictionaryNodeId);

    /* const dataTypeNodeIds =  */
    await _enrichWithDescriptionOf(session, dataTypeDescriptions);

    for (const dataTypeDescription of dataTypeDescriptions) {
        map[dataTypeDescription.browseName.name!.toString()] = dataTypeDescription.encodings!;
    }

    return {
        getDataTypeAndEncodingId(key: string) {
            return map[key];
        }
    };
}

async function _extractDataTypeDictionary(
    session: IBasicSession,
    dataTypeDictionaryNodeId: NodeId,
    dataTypeManager: ExtraDataTypeManager
): Promise<void> {

    const isDictionaryDeprecated = await _readDeprecatedFlag(session, dataTypeDictionaryNodeId);
    const rawSchemaDataValue = await session.read({ nodeId: dataTypeDictionaryNodeId, attributeId: AttributeIds.Value });

    const name = await session.read({ nodeId: dataTypeDictionaryNodeId, attributeId: AttributeIds.BrowseName });
    const namespace = await _readNamespaceUriProperty(session, dataTypeDictionaryNodeId);

    if (isDictionaryDeprecated || !rawSchemaDataValue.value.value) {

        debugLog("DataTypeDictionary is deprecated  or BSD schema stored in dataValue is null ! ", chalk.cyan(name.value.value.toString()), "namespace =", namespace);
        debugLog("lets use the new way (1.04) and let's crawl all dataTypes exposed by this name space");

        // dataType definition in store directily in UADataType under the $definition property
        const dataTypeFactory2 = dataTypeManager.getDataTypeFactory(dataTypeDictionaryNodeId.namespace);
        if (!dataTypeFactory2) {
            throw new Error("cannot find dataTypeFactort for namespace " + dataTypeDictionaryNodeId.namespace);
        }
        await _extractDataTypeDictionaryFromDefinition(session, dataTypeDictionaryNodeId, dataTypeFactory2);
        return;
    } else {

        debugLog(" ----- Using old method for extracting schema => with BSD files");
        // old method ( until 1.03 )
        // one need to read the schema file store in the dataTypeDictionary node and parse it !
        const rawSchema = rawSchemaDataValue.value.value.toString();

        /* istanbul ignore next */
        if (doDebug) {
            debugLog("---------------------------------------------");
            debugLog(rawSchema.toString());
            debugLog("---------------------------------------------");
        }
        const idProvider = await _extractNodeIds(session, dataTypeDictionaryNodeId);
        const dataTypeFactory1 = dataTypeManager.getDataTypeFactory(dataTypeDictionaryNodeId.namespace);
        await parseBinaryXSDAsync(rawSchema, idProvider, dataTypeFactory1);
    }
}

async function _exploreDataTypeDefinition(
    session: IBasicSession,
    dataTypeDictionaryTypeNode: NodeId,
    dataTypeFactory: DataTypeFactory,
    namespaces: string[]
) {

    const nodeToBrowse = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: dataTypeDictionaryTypeNode,
        referenceTypeId: resolveNodeId("HasComponent"),
        resultMask: makeResultMask("ReferenceType | IsForward | BrowseName | NodeClass | TypeDefinition")
    };
    const result = await session.browse(nodeToBrowse);
    const references = result.references || [];

    /* istanbul ignore next */
    if (references.length === 0) {
        return;
    }

    // request the Definition of each nodes
    const nodesToBrowse2 = references.map((ref: ReferenceDescription) => {
        return {
            browseDirection: BrowseDirection.Inverse,
            includeSubtypes: false,
            nodeClassMask: makeNodeClassMask("Object | Variable"),
            nodeId: ref.nodeId,
            referenceTypeId: resolveNodeId("HasDescription"),
            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
        };
    });
    const results2 = await session.browse(nodesToBrowse2);

    const binaryEncodingNodeIds = results2.map((br: BrowseResult) => {
        const defaultBin = br.references!.filter((r: ReferenceDescription) => r.browseName.toString() === "Default Binary");

        /* istanbul ignore next */
        if (defaultBin.length < 1) {
            return ExpandedNodeId;
        }
        return ExpandedNodeId.fromNodeId(defaultBin[0].nodeId, namespaces[defaultBin[0].nodeId.namespace]);
    });

    // follow now Default Binary <= [Has Encoding] = [DataType]

    /* istanbul ignore next */
    if (doDebug) {
        console.log(chalk.bgWhite.red("testing new constructors"));
        const tuples = _.zip(references, binaryEncodingNodeIds);
        for (const [ref, binaryEncoding] of tuples) {

            const name = ref.browseName!.name!.toString();
            debugLog("      type ", name.padEnd(30, " "), binaryEncoding.toString());

            // let's verify that constructor is operational
            try {
                const constructor = dataTypeFactory.getStructureTypeConstructor(name);
                // xx const constructor = getOrCreateConstructor(name, dataTypeFactory, defaultBinary);
                const testObject = new constructor();
                debugLog(testObject.toString());
            } catch (err) {
                debugLog("         Error cannot construct Extension Object " + name);
                debugLog("         " + err.message);
            }
        }
    }
}

/**
 * Extract all custom dataType
 * @param session
 * @param dataTypeManager
 * @async
 */
export async function populateDataTypeManager(
    session: IBasicSession,
    dataTypeManager: ExtraDataTypeManager
) {

    debugLog("in ... populateDataTypeManager");

    // read namespace array
    const dataValueNamespaceArray = await session.read({
        attributeId: AttributeIds.Value,
        nodeId: resolveNodeId("Server_NamespaceArray")
    });

    const namespaceArray = dataValueNamespaceArray.value.value;

    if (dataValueNamespaceArray.statusCode === StatusCodes.Good &&
        (namespaceArray && namespaceArray.length > 0)) {
        dataTypeManager.setNamespaceArray(namespaceArray as string[]);

        for (let namespaceIndex = 1; namespaceIndex < namespaceArray.length; namespaceIndex++) {
            if (dataTypeManager.hasDataTypeFactory(namespaceIndex)) {
                const dataTypeFactory1 = new DataTypeFactory([getStandartDataTypeFactory()]);
                dataTypeManager.registerDataTypeFactory(namespaceIndex, dataTypeFactory1);
            }
        }

    }

    /// to do :: may be not useful
    if (!dataValueNamespaceArray.value.value && dataTypeManager.namespaceArray.length === 0) {
        dataTypeManager.setNamespaceArray([]);
    }

    const dataTypeDictionaryType = resolveNodeId("DataTypeDictionaryType");
    // DataType/OPCBinary => i=93 [OPCBinarySchema_TypeSystem]

    // "OPC Binary"[DataSystemType]
    const opcBinaryNodeId = resolveNodeId("OPCBinarySchema_TypeSystem");

    debugLog(opcBinaryNodeId.toString());

    // let find all DataType dictionary node corresponding to a given namespace
    // (have DataTypeDictionaryType)
    const nodeToBrowse: BrowseDescriptionLike = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: opcBinaryNodeId,
        referenceTypeId: resolveNodeId("HasComponent"),
        resultMask: makeResultMask("ReferenceType | IsForward | BrowseName | NodeClass | TypeDefinition")
    };
    const result = await session.browse(nodeToBrowse);

    if (doDebug) {
        debugLog(result.statusCode.toString());
        debugLog(result.references?.map((r: any) => r.browseName?.toString()).join(" "));
    }

    // filter nodes that have the expected namespace Index
    // ( more specifically we want to filter out DataStructure from namespace 0)
    // we also want to keep only object of type DataTypeDictionaryType
    const references = result.references!.filter(
        (e: ReferenceDescription) => e.nodeId.namespace !== 0 &&
            sameNodeId(e.typeDefinition, dataTypeDictionaryType));

    debugLog(`found ${references.length} dictionnary`);

    // now investigate DataTypeDescriptionType
    await (async () => {
        async function processReference2(ref: ReferenceDescription): Promise<void> {

            const dataTypeDicitionaryNodeId = ref.nodeId;
            // xx const dataTypeFactory = dataTypeManager.getDataTypeFactoryForNamespace(dataTypeDicitionaryNodeId.namespace);

            await _extractDataTypeDictionary(session, dataTypeDicitionaryNodeId, dataTypeManager);
            /* istanbul ignore next */
            if (doDebug) {
                debugLog(chalk.bgWhite("                                         => "), ref.browseName.toString(), ref.nodeId.toString());
            }
            const dataTypeFactory = dataTypeManager.getDataTypeFactoryForNamespace(dataTypeDicitionaryNodeId.namespace);
            await _exploreDataTypeDefinition(session, dataTypeDicitionaryNodeId, dataTypeFactory, dataTypeManager.namespaceArray);

        }
        const promises2: Array<Promise<void>> = [];
        for (const ref of references) {
            promises2.push(processReference2(ref));
        }
        await Promise.all(promises2);

    })();

    debugLog("out ... populateDataTypeManager");
}

async function getHasEncodingDefaultBinary(
    session: IBasicSession,
    dataTypeNodeId: NodeId
): Promise<NodeId> {

    const nodeToBrowse1 = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Object"),
        nodeId: dataTypeNodeId,
        referenceTypeId: resolveNodeId("HasEncoding"),
        resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
    };

    const result1 = await session.browse(nodeToBrowse1);

    if (result1.references && result1.references.length > 1) {
        // we have more than one possible Encoding .... only keep "Default Binary"
        result1.references = result1.references.filter((r: ReferenceDescription) =>
            r.browseName.toString() === "Default Binary");
    }

    /* istanbul ignore next */
    if (!(result1.references && result1.references.length === 1)) {

        const nodeClass = await session.read({
            attributeId: AttributeIds.NodeClass,
            nodeId: dataTypeNodeId
        });
        const browseName = await session.read({
            attributeId: AttributeIds.BrowseName,
            nodeId: dataTypeNodeId
        });

        // tslint:disable:no-console
        console.log("node-id    :", dataTypeNodeId ? dataTypeNodeId.toString() : null);
        console.log("nodeClass  :", NodeClass[nodeClass.value.value]);
        console.log("browseName :", browseName.toString());
        console.log(result1.toString());
        throw new Error("getDataTypeDefinition invalid HasEncoding reference");
    }

    const encodingReference = result1.references![0]!;
    assert(encodingReference.browseName.toString() === "Default Binary");

    /* istanbul ignore next */
    if (doDebug) {
        const browseName = await session.read({
            attributeId: AttributeIds.BrowseName,
            nodeId: dataTypeNodeId
        });
        debugLog(browseName.value.value.toString(), "Has Encoding ", encodingReference.browseName.toString(), encodingReference.nodeId.toString());
    }
    return encodingReference.nodeId;

}

async function getDefinition(session: IBasicSession, defaultBinaryEncodingNodeId: NodeId): Promise<NodeId> {
    const nodeToBrowse2 = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: defaultBinaryEncodingNodeId,
        referenceTypeId: resolveNodeId("HasDescription"),
        resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
    };
    const result2 = await session.browse(nodeToBrowse2);
    assert(result2.references && result2.references.length === 1);
    const definitionRef = result2.references![0]!;

    const nameDataValue = await session.read({
        attributeId: AttributeIds.Value,
        nodeId: definitionRef.nodeId
    });
    if (nameDataValue.statusCode !== StatusCodes.Good) {
        throw new Error("Cannot find ...  " + definitionRef.nodeId.toString());
    }
    /*
    const name = nameDataValue.value.value as string;
    if (!name) {
        console.log(nameDataValue.toString());
        throw new Error("Cannot find ...  " + name + " " + definitionRef.nodeId.toString());
    }
    */
    return definitionRef.nodeId;
}

async function getSchemaNode(session: IBasicSession, definitionRefNodeId: NodeId) {
    // find parent node to access the xsd File
    const nodeToBrowse3 = {
        browseDirection: BrowseDirection.Inverse,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: definitionRefNodeId,
        referenceTypeId: resolveNodeId("HasComponent"),
        resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
    };
    const result3 = await session.browse(nodeToBrowse3);
    assert(result3.references && result3.references.length === 1);
    const schemaNode = result3.references![0]!.nodeId;
    return schemaNode;
}

export async function getDataTypeDefinition(
    session: IBasicSession,
    dataTypeNodeId: NodeId,
    // tslint:disable-next-line: no-shadowed-variable
    dataTypeManager: ExtraDataTypeManager
): Promise<StructuredTypeSchema> {

    // DataType
    //    | 1
    //    | n
    //    +- HasEncoding-> "Default Binary" (O)[DataTypeEncodingType]
    //                           |
    //                           +-- HasDescription -> "MyItemType" (V)[DataTypeDescriptionType]
    //                                                    |
    //                                                    +- ComponentOf -> Schema(V) []
    //                                                                         |
    //                                                                         +- ComponentOf -> OPC Binary(V)[DataTypeSystemType]
    //
    // Note that in 1.04 compliant server, DataType definition might be available
    //           in a DataTypeDefinition attributes of the DataType object
    //           However this is a brand new aspect of the specification and is not widely implemented
    //           it is also optional
    //           It will takes time for old opcua server to be refurbished and we may have to
    //           keep the current method to access type definition from embedded xsd.
    //

    const defaultBinaryEncodingNodeId = await getHasEncodingDefaultBinary(session, dataTypeNodeId);

    const definitionRefNodeId = await getDefinition(session, defaultBinaryEncodingNodeId);

    const schemaNode = await getSchemaNode(session, definitionRefNodeId);

    const dataTypeFactory = dataTypeManager.getDataTypeFactoryForNamespace(schemaNode.namespace);

    /* istanbul ignore next */
    if (!dataTypeFactory) {
        throw new Error(" cannot find typeDictionary for  " + schemaNode.toString());
    }
    const name = await (await session.read({ nodeId: dataTypeNodeId, attributeId: AttributeIds.BrowseName })).value.value.name;

    const schema = dataTypeFactory.getStructuredTypeSchema(name);
    return schema;
}

async function findSuperType(
    session: IBasicSession,
    dataTypeNodeId: NodeId
): Promise<NodeId> {

    const nodeToBrowse3 = {
        browseDirection: BrowseDirection.Inverse,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("DataType"),
        nodeId: dataTypeNodeId,
        referenceTypeId: resolveNodeId("HasSubtype"),
        resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass")
    };
    const result3 = await session.browse(nodeToBrowse3);

    /* istanbul ignore next */
    if (result3.statusCode !== StatusCodes.Good) {
        throw new Error("Cannot find superType for " + dataTypeNodeId.toString());
    }
    result3.references = result3.references || [];

    /* istanbul ignore next */
    if (result3.references.length !== 1) {
        console.log(result3.toString());
        throw new Error("Invalid dataType with more than one superType " + dataTypeNodeId.toString());
    }
    return result3.references[0].nodeId;
}
async function findDataTypeCategory(
    session: IBasicSession,
    cache: { [key: string]: Cache },
    dataTypeNodeId: NodeId
): Promise<FieldCategory> {

    const subTypeNodeId = await findSuperType(session, dataTypeNodeId);
    debugLog("subTypeNodeId  of ", dataTypeNodeId.toString(), " is ", subTypeNodeId.toString());
    const key = subTypeNodeId.toString();
    if (cache[key]) {
        return cache[key].category;
    }
    let category: FieldCategory;
    if (subTypeNodeId.namespace === 0 && subTypeNodeId.value < 29) {
        // well knwow node ID !
        switch (subTypeNodeId.value) {
            case 22: /* Structure */
                category = FieldCategory.complex;
                break;
            case 29: /* Enumeration */
                category = FieldCategory.enumeration;
                break;
            default:
                category = FieldCategory.basic;
                break;
        }
        return category;
    }
    // must drill down ...
    return await findDataTypeCategory(session, cache, subTypeNodeId);
}

async function findDataTypeBasicType(
    session: IBasicSession,
    cache: { [key: string]: Cache },
    dataTypeNodeId: NodeId
): Promise<TypeDefinition> {
    const subTypeNodeId = await findSuperType(session, dataTypeNodeId);

    debugLog("subTypeNodeId  of ", dataTypeNodeId.toString(), " is ", subTypeNodeId.toString());

    const key = subTypeNodeId.toString();
    if (cache[key]) {
        return cache[key].schema;
    }
    if (subTypeNodeId.namespace === 0 && subTypeNodeId.value < 29) {
        switch (subTypeNodeId.value) {
            case 22: /* Structure */
            case 29: /* Enumeration */
                throw new Error("Not expecting Structure or Enumeration");
            default:
                break;
        }
        const nameDataValue: DataValue = await session.read({ nodeId: subTypeNodeId, attributeId: AttributeIds.BrowseName });
        const name = nameDataValue.value.value.name!;
        return getBuildInType(name);
    }
    // must drill down ...
    return await findDataTypeBasicType(session, cache, subTypeNodeId);
}

interface Cache {
    fieldTypeName: string;
    schema: TypeDefinition;
    category: FieldCategory;
}

async function readBrowseName(session: IBasicSession, nodeId: NodeId): Promise<string> {
    const dataValue = await session.read({ nodeId, attributeId: AttributeIds.BrowseName });
    if (dataValue.statusCode !== StatusCodes.Good) {
        const message = "cannot extract BrowseName of nodeId = " + nodeId.toString();
        debugLog(message);
        throw new Error(message);
    }
    return dataValue.value!.value.name;
}

async function resolveFieldType(
    session: IBasicSession,
    dataTypeNodeId: NodeId,
    dataTypeFactory: DataTypeFactory,
    cache: { [key: string]: Cache }
): Promise<Cache | null> {

    if (dataTypeNodeId.value === 0) {
        // this is the default Structure !
        // throw new Error("invalid nodeId " + dataTypeNodeId.toString());
        return null;
    }
    const key = dataTypeNodeId.toString();
    const v = cache[key];
    if (v) {
        return v;
    }
    const fieldTypeName = await readBrowseName(session, dataTypeNodeId);

    let schema: TypeDefinition;
    let category: FieldCategory = FieldCategory.enumeration;

    if (dataTypeFactory.hasStructuredType(fieldTypeName!)) {
        schema = dataTypeFactory.getStructuredTypeSchema(fieldTypeName);
        category = FieldCategory.complex;
    } else if (dataTypeFactory.hasSimpleType(fieldTypeName!)) {
        category = FieldCategory.basic;
        schema = dataTypeFactory.getSimpleType(fieldTypeName!);
    } else if (dataTypeFactory.hasEnumeration(fieldTypeName!)) {
        category = FieldCategory.enumeration;
        schema = dataTypeFactory.getEnumeration(fieldTypeName!)!;
    } else {

        debugLog(" type " + fieldTypeName + " has not been seen yet, let resolve it");
        category = await findDataTypeCategory(session, cache, dataTypeNodeId);

        debugLog(" type " + fieldTypeName + " has not been seen yet, let resolve it (category = ", category, " )");

        switch (category) {
            case "basic":
                schema = await findDataTypeBasicType(session, cache, dataTypeNodeId);
                break;
            default:
            case "complex":
            case "enumeration":
                const dataTypeDefinitionDataValue = await session.read({
                    attributeId: AttributeIds.DataTypeDefinition,
                    nodeId: dataTypeNodeId,
                });

                /* istanbul ignore next */
                if (dataTypeDefinitionDataValue.statusCode !== StatusCodes.Good) {
                    throw new Error(" Cannot find dataType Definition!");
                }

                const definition = dataTypeDefinitionDataValue.value.value;
                // schema = await convertDataTypeDefinitionToStructureTypeSchema(session, fieldTypeName, definition, dataTypeFactory, cache);
                schema = dataTypeFactory.getStructuredTypeSchema(fieldTypeName);
                break;
        }
    }

    assert(schema, "expecting a schema here");
    const v2: Cache = {
        category,
        fieldTypeName,
        schema
    };
    cache[key] = v2;
    return v2;
}

async function _setupEncodings(
    session: IBasicSession,
    dataTypeNodeId: NodeId,
    schema: StructuredTypeSchema
): Promise<StructuredTypeSchema> {

    schema.dataTypeNodeId = dataTypeNodeId;
    schema.id = dataTypeNodeId;
    const encodings = await _findEncodings(session, dataTypeNodeId);
    schema.encodingDefaultBinary = makeExpandedNodeId(encodings.binaryEncodingNodeId);
    schema.encodingDefaultXml = makeExpandedNodeId(encodings.xmlEncodingNodeId);
    schema.encodingDefaultJson = makeExpandedNodeId(encodings.jsonEncodingNodeId);

    return schema;
}

export async function convertDataTypeDefinitionToStructureTypeSchema(
    session: IBasicSession,
    dataTypeNodeId: NodeId,
    name: string,
    definition: DataTypeDefinition,
    dataTypeFactory: DataTypeFactory,
    cache: { [key: string]: Cache }
): Promise<StructuredTypeSchema> {

    if (definition instanceof StructureDefinition) {

        switch (definition.structureType) {
            case StructureType.Structure:
            case StructureType.StructureWithOptionalFields:
                break;
        }
        const fields: FieldInterfaceOptions[] = [];

        for (const fieldD of definition.fields!) {

            const { schema, category, fieldTypeName } = (await resolveFieldType(session, fieldD.dataType, dataTypeFactory, cache))!;
            const field: FieldInterfaceOptions = {
                fieldType: fieldTypeName!,
                name: fieldD.name!,
                schema,
            };

            if (fieldD.valueRank === 1) {
                field.isArray = true;
            }
            field.category = category;
            fields.push(field);
        }

        const a = await resolveFieldType(session, definition.baseDataType, dataTypeFactory, cache);
        const baseType = a ? a.fieldTypeName : "ExtensionObject";

        const os = new StructuredTypeSchema({
            baseType,
            fields,
            id: 0,
            name,
        });

        return await _setupEncodings(session, dataTypeNodeId, os);
    }
    throw new Error("Not Implemented");
}
